// Captura multicanal NATIVA (macOS). Chrome/Electron només en deixa passar 2 canals de qualsevol targeta;
// aquest programa en llegeix tots (targeta física o virtual: Dante Virtual Soundcard, Loopback, BlackHole…).
//
//   captura llista                 → JSON: [{ "uid", "name", "channels" }] de les entrades
//   captura pdf <fitxer>           → el text d'un PDF (per preparar guions des de l'app)
//   captura <uid> <c0,c1,...>      → llegeix els canals indicats (0 = primer) i escriu a stdout, bloc a bloc:
//        "CAP1" | u32 frames | u16 canals | u32 freqüència | Float32 entrellaçat (canals × frames)
//
// Fa servir AUHAL (la capa d'àudio de baix nivell de macOS), que és la que permet triar una targeta concreta
// i llegir-ne tots els canals. El servidor fa la resta (24 kHz, qui parla, OpenAI). Si el dispositiu
// desapareix o canvia, el programa surt i el servidor el torna a engegar.
import AudioToolbox
import PDFKit
import CoreAudio
import Foundation

let errOut = FileHandle.standardError
func say(_ s: String) { errOut.write((s + "\n").data(using: .utf8)!) }
func fail(_ s: String) -> Never { say(s); exit(1) }

func allDevices() -> [AudioDeviceID] {
    var addr = AudioObjectPropertyAddress(mSelector: kAudioHardwarePropertyDevices, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
    var size: UInt32 = 0
    AudioObjectGetPropertyDataSize(AudioObjectID(kAudioObjectSystemObject), &addr, 0, nil, &size)
    var ids = [AudioDeviceID](repeating: 0, count: Int(size) / MemoryLayout<AudioDeviceID>.size)
    AudioObjectGetPropertyData(AudioObjectID(kAudioObjectSystemObject), &addr, 0, nil, &size, &ids)
    return ids
}
func strProp(_ id: AudioDeviceID, _ sel: AudioObjectPropertySelector) -> String {
    var addr = AudioObjectPropertyAddress(mSelector: sel, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
    var s: Unmanaged<CFString>? = nil
    var size = UInt32(MemoryLayout<CFString?>.size)
    guard AudioObjectGetPropertyData(id, &addr, 0, nil, &size, &s) == noErr, let v = s?.takeRetainedValue() else { return "" }
    return v as String
}
func inputChannels(_ id: AudioDeviceID) -> Int {
    var addr = AudioObjectPropertyAddress(mSelector: kAudioDevicePropertyStreamConfiguration, mScope: kAudioDevicePropertyScopeInput, mElement: kAudioObjectPropertyElementMain)
    var size: UInt32 = 0
    guard AudioObjectGetPropertyDataSize(id, &addr, 0, nil, &size) == noErr, size > 0 else { return 0 }
    let raw = UnsafeMutableRawPointer.allocate(byteCount: Int(size), alignment: 16); defer { raw.deallocate() }
    guard AudioObjectGetPropertyData(id, &addr, 0, nil, &size, raw) == noErr else { return 0 }
    return UnsafeMutableAudioBufferListPointer(raw.assumingMemoryBound(to: AudioBufferList.self)).reduce(0) { $0 + Int($1.mNumberChannels) }
}
func nominalRate(_ id: AudioDeviceID) -> Double {
    var addr = AudioObjectPropertyAddress(mSelector: kAudioDevicePropertyNominalSampleRate, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
    var r: Float64 = 0; var size = UInt32(MemoryLayout<Float64>.size)
    AudioObjectGetPropertyData(id, &addr, 0, nil, &size, &r)
    return r
}

let args = Array(CommandLine.arguments.dropFirst())
guard let cmd = args.first else { fail("ús: captura llista | captura <uid> <canals>") }

if cmd == "pdf" {
    guard args.count > 1, let doc = PDFDocument(url: URL(fileURLWithPath: args[1])) else { fail("no es pot obrir el PDF") }
    var out = ""
    for i in 0..<doc.pageCount { if let t = doc.page(at: i)?.string { out += t + "\n\n" } }
    FileHandle.standardOutput.write(out.data(using: .utf8)!)
    exit(0)
}

if cmd == "llista" {
    let list = allDevices().compactMap { d -> [String: Any]? in
        let n = inputChannels(d); guard n > 0 else { return nil }
        return ["uid": strProp(d, kAudioDevicePropertyDeviceUID), "name": strProp(d, kAudioObjectPropertyName), "channels": n, "rate": nominalRate(d)]
    }
    FileHandle.standardOutput.write(try! JSONSerialization.data(withJSONObject: list))
    FileHandle.standardOutput.write("\n".data(using: .utf8)!)
    exit(0)
}

guard let dev = allDevices().first(where: { strProp($0, kAudioDevicePropertyDeviceUID) == cmd }) else { fail("no trobo el dispositiu \(cmd)") }
let total = inputChannels(dev)
if total == 0 { fail("el dispositiu no té entrades") }
let wanted = (args.count > 1 ? args[1] : "").split(separator: ",").compactMap { Int($0) }.filter { $0 >= 0 && $0 < total }
let chans = wanted.isEmpty ? Array(0..<total) : wanted
let rate = nominalRate(dev)

// ─── AUHAL ───
var desc = AudioComponentDescription(componentType: kAudioUnitType_Output, componentSubType: kAudioUnitSubType_HALOutput,
                                     componentManufacturer: kAudioUnitManufacturer_Apple, componentFlags: 0, componentFlagsMask: 0)
guard let comp = AudioComponentFindNext(nil, &desc) else { fail("sense AUHAL") }
var unitOpt: AudioUnit?
if AudioComponentInstanceNew(comp, &unitOpt) != noErr { fail("no es pot crear l'AUHAL") }
let unit = unitOpt!
var one: UInt32 = 1, zero: UInt32 = 0
AudioUnitSetProperty(unit, kAudioOutputUnitProperty_EnableIO, kAudioUnitScope_Input, 1, &one, 4)   // entrada sí
AudioUnitSetProperty(unit, kAudioOutputUnitProperty_EnableIO, kAudioUnitScope_Output, 0, &zero, 4) // sortida no
var devID = dev
var st = AudioUnitSetProperty(unit, kAudioOutputUnitProperty_CurrentDevice, kAudioUnitScope_Global, 0, &devID, UInt32(MemoryLayout<AudioDeviceID>.size))
if st != noErr { fail("no es pot obrir el dispositiu (\(st))") }
// Format que volem rebre: Float32 no entrellaçat, tots els canals, a la freqüència del dispositiu
var fmt = AudioStreamBasicDescription(mSampleRate: rate, mFormatID: kAudioFormatLinearPCM,
                                      mFormatFlags: kAudioFormatFlagIsFloat | kAudioFormatFlagIsPacked | kAudioFormatFlagIsNonInterleaved,
                                      mBytesPerPacket: 4, mFramesPerPacket: 1, mBytesPerFrame: 4, mChannelsPerFrame: UInt32(total), mBitsPerChannel: 32, mReserved: 0)
st = AudioUnitSetProperty(unit, kAudioUnitProperty_StreamFormat, kAudioUnitScope_Output, 1, &fmt, UInt32(MemoryLayout<AudioStreamBasicDescription>.size))
if st != noErr { fail("format no acceptat (\(st))") }

let maxFrames = 8192
let abl = AudioBufferList.allocate(maximumBuffers: total)
for i in 0..<total { abl[i] = AudioBuffer(mNumberChannels: 1, mDataByteSize: UInt32(maxFrames * 4), mData: malloc(maxFrames * 4)) }
let out = FileHandle.standardOutput
var interleaved = [Float](repeating: 0, count: maxFrames * chans.count)

let callback: AURenderCallback = { _, flags, ts, bus, frames, _ in
    for i in 0..<total { abl[i].mDataByteSize = frames * 4 }
    let r = AudioUnitRender(unit, flags, ts, bus, frames, abl.unsafeMutablePointer)
    if r != noErr { return r }
    let n = Int(frames), k = chans.count
    for (j, c) in chans.enumerated() {
        let p = abl[c].mData!.assumingMemoryBound(to: Float.self)
        for i in 0..<n { interleaved[i * k + j] = p[i] }
    }
    var head = Data(capacity: 14)
    head.append("CAP1".data(using: .ascii)!)
    var f32 = UInt32(n).littleEndian, k16 = UInt16(k).littleEndian, sr = UInt32(rate).littleEndian
    withUnsafeBytes(of: &f32) { head.append(contentsOf: $0) }
    withUnsafeBytes(of: &k16) { head.append(contentsOf: $0) }
    withUnsafeBytes(of: &sr) { head.append(contentsOf: $0) }
    let body = interleaved.withUnsafeBufferPointer { Data(buffer: UnsafeBufferPointer(start: $0.baseAddress, count: n * k)) }
    do { try out.write(contentsOf: head + body) } catch { exit(0) } // el servidor ha tancat: plegar
    return noErr
}
var cb = AURenderCallbackStruct(inputProc: callback, inputProcRefCon: nil)
AudioUnitSetProperty(unit, kAudioOutputUnitProperty_SetInputCallback, kAudioUnitScope_Global, 0, &cb, UInt32(MemoryLayout<AURenderCallbackStruct>.size))
var maxF = UInt32(maxFrames)
AudioUnitSetProperty(unit, kAudioUnitProperty_MaximumFramesPerSlice, kAudioUnitScope_Global, 0, &maxF, 4)
if AudioUnitInitialize(unit) != noErr { fail("no s'ha pogut inicialitzar l'entrada") }
if AudioOutputUnitStart(unit) != noErr { fail("no s'ha pogut començar a capturar") }
say("captura: \(strProp(dev, kAudioObjectPropertyName)) · \(total) canals · \(Int(rate)) Hz · llegint \(chans)")

// Si el dispositiu desapareix (cable, Dante aturat), sortim perquè el servidor ens torni a engegar
var aliveAddr = AudioObjectPropertyAddress(mSelector: kAudioDevicePropertyDeviceIsAlive, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
AudioObjectAddPropertyListenerBlock(dev, &aliveAddr, nil) { _, _ in say("captura: el dispositiu ha desaparegut"); exit(2) }
signal(SIGPIPE, SIG_IGN)
RunLoop.main.run()
