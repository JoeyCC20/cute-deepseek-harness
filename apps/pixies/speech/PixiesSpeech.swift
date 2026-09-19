// pixies-speech: macOS SFSpeechRecognizer CLI for the Pixies shell.
//
// Subcommands:
//   probe                  Print a read-only TCC authorization report as one
//                          JSON line, then exit. Prompts nothing.
//   listen [--locale tag]  Stream recognition as NDJSON on stdout:
//                          {"type":"ready"} {"type":"partial","text":..}
//                          {"type":"final","text":..} {"type":"error","message":..}
//                          Stop on stdin EOF or SIGTERM/SIGINT.
//
// TCC note: the responsible process is the spawning app (the Pixies Electron
// shell), so the usage descriptions come from that bundle's Info.plist; the
// dev launcher patches NSSpeechRecognitionUsageDescription in.

import AVFoundation
import Foundation
import Speech

private let outQueue = DispatchQueue(label: "pixies-speech.out")

func emit(_ payload: [String: Any]) {
  guard let data = try? JSONSerialization.data(withJSONObject: payload),
        var line = String(data: data, encoding: .utf8) else { return }
  line += "\n"
  outQueue.sync {
    FileHandle.standardOutput.write(Data(line.utf8))
  }
}

func emitError(_ message: String) -> Never {
  emit(["type": "error", "message": message])
  exit(1)
}

func probe() -> Never {
  let speechStatus: String
  switch SFSpeechRecognizer.authorizationStatus() {
  case .authorized: speechStatus = "authorized"
  case .denied: speechStatus = "denied"
  case .restricted: speechStatus = "restricted"
  case .notDetermined: speechStatus = "notDetermined"
  @unknown default: speechStatus = "unknown"
  }
  let micStatus: String
  switch AVCaptureDevice.authorizationStatus(for: .audio) {
  case .authorized: micStatus = "authorized"
  case .denied: micStatus = "denied"
  case .restricted: micStatus = "restricted"
  case .notDetermined: micStatus = "notDetermined"
  @unknown default: micStatus = "unknown"
  }
  emit(["type": "probe", "status": speechStatus, "microphone": micStatus])
  exit(0)
}

/// One live recognition round: a fresh buffer request fed by the shared tap,
/// restarted after every final result (recognition tasks cap out around one
/// minute, so restarts are the steady state, not an error path).
final class RecognitionLoop {
  private let recognizer: SFSpeechRecognizer
  private let engine = AVAudioEngine()
  private var request: SFSpeechAudioBufferRecognitionRequest?
  private var task: SFSpeechRecognitionTask?
  private var lastPartial = ""
  private var consecutiveFailures = 0
  private var stopped = false
  /// Fires `endAudio()` a beat after the last transcription advance so a final
  /// result actually arrives; without it the request keeps buffering audio and
  /// SFSpeechRecognizer may never mark the result final (the user's message then
  /// stays a partial forever and is never delivered downstream).
  private var endSilence: DispatchWorkItem?

  init(recognizer: SFSpeechRecognizer) {
    self.recognizer = recognizer
  }

  func start() {
    guard !stopped else { return }
    let input = engine.inputNode
    let format = input.outputFormat(forBus: 0)
    guard format.sampleRate > 0 else {
      emitError("no input format available (no microphone?)")
      return
    }
    let request = SFSpeechAudioBufferRecognitionRequest()
    request.shouldReportPartialResults = true
    self.request = request
    lastPartial = ""
    input.installTap(onBus: 0, bufferSize: 1024, format: format) { [weak request] buffer, _ in
      request?.append(buffer)
    }
    task = recognizer.recognitionTask(with: request) { [weak self] result, error in
      guard let self, !self.stopped else { return }
      if let result {
        let text = result.bestTranscription.formattedString
        if result.isFinal {
          self.endSilence?.cancel()
          self.endSilence = nil
          if !text.isEmpty {
            self.consecutiveFailures = 0
            emit(["type": "final", "text": text])
          }
          self.restart()
        } else if !text.isEmpty, text != self.lastPartial {
          self.lastPartial = text
          self.consecutiveFailures = 0
          emit(["type": "partial", "text": text])
          self.scheduleEndAudio()
        }
      }
      if let error {
        self.consecutiveFailures += 1
        if self.consecutiveFailures > 5 {
          emitError("recognition failed repeatedly: \(error)")
          return
        }
        self.restart()
      }
    }
    do {
      engine.prepare()
      try engine.start()
      emit(["type": "ready"])
    } catch {
      emitError("engine start failed: \(error)")
    }
  }

  /// (Re)arm the silence deadline: every transcription advance restarts a short
  /// window, and when it lapses the round is ended so a final result fires.
  private func scheduleEndAudio() {
    endSilence?.cancel()
    let item = DispatchWorkItem { [weak self] in
      guard let self else { return }
      // Stop the audio inflow before ending: an ended request must not receive
      // more buffers. removeTap is idempotent here via try?.
      try? self.engine.inputNode.removeTap(onBus: 0)
      self.request?.endAudio()
    }
    endSilence = item
    DispatchQueue.global().asyncAfter(deadline: .now() + 1.5, execute: item)
  }

  private func restart() {
    teardownRound()
    DispatchQueue.global().asyncAfter(deadline: .now() + 0.15) { [weak self] in
      self?.start()
    }
  }

  private func teardownRound() {
    endSilence?.cancel()
    endSilence = nil
    task?.cancel()
    task = nil
    request?.endAudio()
    request = nil
    try? engine.inputNode.removeTap(onBus: 0)
  }

  func stop() {
    stopped = true
    teardownRound()
    engine.stop()
  }
}

private var stopSources: [DispatchSourceSignal] = []

func installStopHandlers(onStop: @escaping () -> Void) {
  for signalNumber in [SIGTERM, SIGINT] {
    signal(signalNumber, SIG_IGN)
    let source = DispatchSource.makeSignalSource(signal: signalNumber, queue: .main)
    source.setEventHandler(handler: onStop)
    source.resume()
    stopSources.append(source)
  }
}

/// Exit once stdin closes (the Node controller's primary stop signal).
func watchStdinEof(onEnd: @escaping () -> Void) {
  DispatchQueue.global().async {
    let handle = FileHandle.standardInput
    while true {
      let data = handle.availableData
      if data.isEmpty { break }
    }
    onEnd()
  }
}

func listen(locale: String) -> Never {
  guard let recognizer = SFSpeechRecognizer(locale: Locale(identifier: locale)) else {
    emitError("recognizer unavailable for locale \(locale)")
  }
  SFSpeechRecognizer.requestAuthorization { status in
    guard status == .authorized else {
      emitError("speech recognition not authorized (status \(status.rawValue)); grant via System Settings")
      return
    }
    AVCaptureDevice.requestAccess(for: .audio) { granted in
      guard granted else { emitError("microphone access denied") }
      let loop = RecognitionLoop(recognizer: recognizer)
      let shutdown = { loop.stop(); exit(0) }
      installStopHandlers(onStop: shutdown)
      watchStdinEof(onEnd: shutdown)
      loop.start()
    }
  }
  dispatchMain()
}

let arguments = CommandLine.arguments
let subcommand = arguments.count > 1 ? arguments[1] : ""
switch subcommand {
case "probe":
  probe()
case "listen":
  var locale = ProcessInfo.processInfo.environment["DSH_PIXIES_SPEECH_LOCALE"] ?? "zh-CN"
  if let index = arguments.firstIndex(of: "--locale"), index + 1 < arguments.count {
    locale = arguments[index + 1]
  }
  listen(locale: locale)
default:
  emitError("usage: pixies-speech probe | pixies-speech listen [--locale zh-CN]")
}
