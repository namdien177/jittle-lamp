// jl-intelligence-helper: titles and describes a recording with Apple Intelligence, on the device.
//
//   jl-intelligence-helper [--timeout-ms N] < input.json > output.json
//   jl-intelligence-helper --availability
//
// Input is `SuggestionInput` from `src/lib.rs` (camelCase JSON) plus an optional `framePath`.
// Output is one JSON object on stdout:
//   { "available": true, "title": "…", "description": "…", "ocrLines": 12, "elapsedMs": 812 }
//   { "available": false, "reason": "appleIntelligenceNotEnabled", "message": "…" }
//   { "available": true, "error": "…" }
// The exit status is 0 whenever a JSON object was written. Nothing leaves the machine: Vision and
// the system language model both run locally.

import Foundation
import ImageIO
import Vision

#if canImport(FoundationModels)
import FoundationModels
#endif

// MARK: - Protocol

struct Input: Decodable {
    struct Source: Decodable {
        var kind: String
        var name: String
        var bundleId: String?
    }
    struct Action: Decodable {
        var atMs: Int
        var label: String
    }
    struct Console: Decodable {
        var atMs: Int
        var level: String
        var message: String
    }
    struct Request: Decodable {
        var atMs: Int
        var method: String
        var path: String
        var status: Int?
        var failure: String?
    }

    var source: Source
    var pageUrl: String
    var pageTitle: String
    var windowTitles: [String]
    var actions: [Action]
    var console: [Console]
    var failedRequests: [Request]
    var durationMs: Double?
    var markers: [String]
    var framePath: String?
}

/// Only the first caller writes; a racing one (the deadline vs. a late result) blocks until exit.
let emitLock = NSLock()

func emit(_ object: [String: Any]) -> Never {
    emitLock.lock()
    let options: JSONSerialization.WritingOptions = [.sortedKeys, .withoutEscapingSlashes]
    let data = (try? JSONSerialization.data(withJSONObject: object, options: options)) ?? Data("{\"error\":\"encode\"}".utf8)
    FileHandle.standardOutput.write(data)
    FileHandle.standardOutput.write(Data("\n".utf8))
    // The reply is written; skip atexit teardown, which can wait on Vision or model work still
    // running on other threads.
    _exit(0)
}

func unavailable(_ reason: String, _ message: String) -> Never {
    emit(["available": false, "reason": reason, "message": message])
}

// MARK: - Arguments

let arguments = CommandLine.arguments.dropFirst()
let timeoutMs: Int = {
    guard let index = arguments.firstIndex(of: "--timeout-ms"), arguments.index(after: index) < arguments.endIndex,
          let value = Int(arguments[arguments.index(after: index)]), value > 0 else { return 20_000 }
    return value
}()

// Never hang the caller: whatever is still running when the deadline passes is abandoned.
DispatchQueue.global().asyncAfter(deadline: .now() + .milliseconds(timeoutMs)) {
    emit(["available": true, "error": "timed out after \(timeoutMs) ms"])
}

// MARK: - Availability

/// `nil` when the model can be used, else (reason, message).
func modelUnavailability() -> (String, String)? {
    #if canImport(FoundationModels)
    if #available(macOS 26.0, *) {
        switch SystemLanguageModel.default.availability {
        case .available:
            return nil
        case .unavailable(.deviceNotEligible):
            return ("deviceNotEligible", "This Mac doesn't support Apple Intelligence.")
        case .unavailable(.appleIntelligenceNotEnabled):
            return ("appleIntelligenceNotEnabled", "Apple Intelligence is turned off in System Settings.")
        case .unavailable(.modelNotReady):
            return ("modelNotReady", "The Apple Intelligence model is still downloading or preparing.")
        case .unavailable(let other):
            return ("unknown", "Apple Intelligence is unavailable (\(other)).")
        }
    }
    #endif
    return ("unsupportedOS", "Apple Intelligence needs macOS 26 or later.")
}

if arguments.contains("--availability") {
    if let (reason, message) = modelUnavailability() { unavailable(reason, message) }
    emit(["available": true])
}

// MARK: - On-screen text

final class TextRecognition: @unchecked Sendable {
    let request = VNRecognizeTextRequest()
    var lines: [String] = []
}

/// Text recognition with its own deadline: the first accurate pass after boot can take many
/// seconds while Vision loads its models, and a suggestion without screen text beats none.
func recognizeText(at path: String, budgetMs: Int) -> (lines: [String], ms: Int, timedOut: Bool) {
    let started = Date()
    let job = TextRecognition()
    let done = DispatchSemaphore(value: 0)
    DispatchQueue.global(qos: .userInitiated).async {
        job.lines = recognizeText(at: path, request: job.request)
        done.signal()
    }
    let timedOut = done.wait(timeout: .now() + .milliseconds(budgetMs)) == .timedOut
    if timedOut { job.request.cancel() }
    return (timedOut ? [] : job.lines, Int(Date().timeIntervalSince(started) * 1000), timedOut)
}

/// Recognized lines in reading order, without near-duplicates and noise, capped for the prompt.
func recognizeText(at path: String, request: VNRecognizeTextRequest, maxLines: Int = 30,
                   maxCharacters: Int = 1_200) -> [String] {
    let url = URL(fileURLWithPath: path)
    guard let source = CGImageSourceCreateWithURL(url as CFURL, nil),
          let image = CGImageSourceCreateImageAtIndex(source, 0, nil) else { return [] }
    request.recognitionLevel = .accurate
    request.usesLanguageCorrection = true
    request.automaticallyDetectsLanguage = true
    do {
        try VNImageRequestHandler(cgImage: image, options: [:]).perform([request])
    } catch {
        return []
    }
    let observations = (request.results ?? []).sorted { a, b in
        // Vision's origin is bottom-left: higher boxes first, then left to right on the same row.
        let rowA = a.boundingBox.midY, rowB = b.boundingBox.midY
        if abs(rowA - rowB) > 0.01 { return rowA > rowB }
        return a.boundingBox.minX < b.boundingBox.minX
    }
    var lines: [String] = []
    var seen = Set<String>()
    var total = 0
    for observation in observations {
        guard let candidate = observation.topCandidates(1).first, candidate.confidence >= 0.4 else { continue }
        let text = candidate.string.split(whereSeparator: \.isWhitespace).joined(separator: " ")
        guard text.count >= 3, text.contains(where: \.isLetter) else { continue }
        let key = text.lowercased()
        guard seen.insert(key).inserted else { continue }
        let line = text.count > 100 ? String(text.prefix(99)) + "…" : text
        if total + line.count > maxCharacters { break }
        lines.append(line)
        total += line.count
        if lines.count >= maxLines { break }
    }
    return lines
}

// MARK: - Prompt

func clock(_ ms: Int) -> String {
    let seconds = max(ms, 0) / 1000
    return String(format: "%02d:%02d", seconds / 60, seconds % 60)
}

func describeDuration(_ ms: Double) -> String {
    let seconds = Int((ms / 1000).rounded())
    return seconds < 60 ? "\(seconds) s" : "\(seconds / 60) min \(seconds % 60) s"
}

/// `compact` drops the on-screen text and halves the lists, for a retry after a context overflow.
func buildPrompt(_ input: Input, screenText: [String], compact: Bool) -> String {
    let keep = { (count: Int) in compact ? max(count / 2, 1) : count }
    var parts: [String] = []
    var source = "Recorded \(input.source.kind): \(input.source.name)"
    if let bundleId = input.source.bundleId, !bundleId.isEmpty { source += " (\(bundleId))" }
    parts.append(source)
    if !input.pageTitle.isEmpty, input.pageTitle != input.source.name { parts.append("Page or window: \(input.pageTitle)") }
    if !input.pageUrl.isEmpty, !input.pageUrl.hasPrefix("app://"), !input.pageUrl.hasPrefix("screen://") {
        parts.append("URL: \(input.pageUrl)")
    }
    if let duration = input.durationMs { parts.append("Duration: \(describeDuration(duration))") }
    let titles = input.windowTitles.filter { $0 != input.pageTitle }
    if !titles.isEmpty { parts.append("Windows seen: " + titles.prefix(keep(8)).joined(separator: " | ")) }
    if !input.markers.isEmpty {
        parts.append("Tester's markers:\n" + input.markers.prefix(keep(10)).map { "- \($0)" }.joined(separator: "\n"))
    }
    if !input.actions.isEmpty {
        let lines = input.actions.suffix(keep(input.actions.count)).map { "[\(clock($0.atMs))] \($0.label)" }
        parts.append("User actions:\n" + lines.joined(separator: "\n"))
    }
    if !input.console.isEmpty {
        parts.append("Console errors and warnings:\n" + input.console.prefix(keep(input.console.count))
            .map { "[\(clock($0.atMs))] \($0.level): \($0.message)" }.joined(separator: "\n"))
    }
    if !input.failedRequests.isEmpty {
        parts.append("Failed network requests:\n" + input.failedRequests.prefix(keep(input.failedRequests.count)).map { request in
            let outcome = request.status.map(String.init) ?? (request.failure ?? "failed")
            return "[\(clock(request.atMs))] \(request.method) \(request.path) → \(outcome)"
        }.joined(separator: "\n"))
    }
    if input.console.isEmpty && input.failedRequests.isEmpty {
        parts.append("No console errors or failed requests were captured.")
    }
    if !compact, !screenText.isEmpty {
        parts.append("Text visible on screen:\n" + screenText.joined(separator: "\n"))
    }
    parts.append("Write the title and description for this recording.")
    return parts.joined(separator: "\n\n")
}

let instructions = """
You write the title and description for a QA evidence recording: a screen recording a tester made \
of an app or website, with the clicks, console messages and network requests captured alongside it.

Title: write it like a good bug ticket. Name the app or screen and the specific thing that happened \
or failed, e.g. "Invoices: Export CSV downloads an empty file" or "Profile: Save fails with 422 \
from /api/users/me". At most 70 characters. No trailing period, no quotation marks, and never start \
with "Recording of", "Video of" or "Session". If nothing failed, describe the flow that was exercised.

Description: one to three plain sentences saying what the user did and what went wrong, citing the \
concrete error, status code or message from the evidence. If nothing failed, say what was done and \
that no errors were captured.

Rules:
- The tester's markers are notes they added while recording; they say what the recording is meant \
to show, so follow them.
- The first error right after a user action is usually the one that matters. Keep separate errors \
separate: never attach one error's status code or message to another error.
- Prefer the error's own words (for example "no permission to save") over bare codes.
- Do not speculate about causes, and do not mention anything that is not in the evidence.
"""

// MARK: - Generation

#if canImport(FoundationModels)
@available(macOS 26.0, *)
@Generable
struct EvidenceSummary {
    @Guide(description: "Bug-ticket style title naming the app or screen and what happened; at most 70 characters, no trailing period, no quotes")
    var title: String

    @Guide(description: "One to three plain sentences: what the user did and what went wrong, citing errors or status codes from the evidence")
    var description: String
}

@available(macOS 26.0, *)
func generateGuided(_ prompt: String) async throws -> (String, String) {
    let session = LanguageModelSession(instructions: instructions)
    let response = try await session.respond(
        to: prompt, generating: EvidenceSummary.self, options: GenerationOptions(temperature: 0.2))
    return (response.content.title, response.content.description)
}

/// Fallback for prompts the default guardrails reject (crash logs and error text trip them more
/// than prose does): permissive guardrails only apply to plain-text generation.
@available(macOS 26.0, *)
func generatePlain(_ prompt: String) async throws -> (String, String) {
    let model = SystemLanguageModel(guardrails: .permissiveContentTransformations)
    let session = LanguageModelSession(model: model, instructions: instructions + """


    Answer in exactly two lines:
    Title: <title>
    Description: <description>
    """)
    let response = try await session.respond(to: prompt, options: GenerationOptions(temperature: 0.2))
    var title = "", description = ""
    for line in response.content.split(separator: "\n") {
        let trimmed = line.trimmingCharacters(in: .whitespaces)
        if trimmed.lowercased().hasPrefix("title:") {
            title = String(trimmed.dropFirst(6)).trimmingCharacters(in: .whitespaces)
        } else if trimmed.lowercased().hasPrefix("description:") {
            description = String(trimmed.dropFirst(12)).trimmingCharacters(in: .whitespaces)
        } else if !description.isEmpty {
            description += " " + trimmed
        }
    }
    return (title, description)
}

enum Retry { case permissive, compact, none }

@available(macOS 26.0, *)
func retryKind(for error: Error) -> Retry {
    if let error = error as? LanguageModelSession.GenerationError {
        switch error {
        case .guardrailViolation, .refusal: return .permissive
        case .exceededContextWindowSize: return .compact
        default: return .none
        }
    }
    // macOS 27 reports the same conditions through newer error types.
    let text = String(describing: error).lowercased()
    if text.contains("guardrail") || text.contains("refus") { return .permissive }
    if text.contains("context") { return .compact }
    return .none
}
#endif

// MARK: - Main

let started = Date()
let stdinData = FileHandle.standardInput.readDataToEndOfFile()
let input: Input
do {
    input = try JSONDecoder().decode(Input.self, from: stdinData)
} catch {
    emit(["available": true, "error": "invalid input: \(error)"])
}

if let (reason, message) = modelUnavailability() { unavailable(reason, message) }

// At most 40% of the time (and 6 s) goes to reading the frame; the model needs the rest.
let ocr = input.framePath.map { recognizeText(at: $0, budgetMs: min(6_000, timeoutMs * 2 / 5)) }
let screenText = ocr?.lines ?? []

#if canImport(FoundationModels)
if #available(macOS 26.0, *) {
    Task {
        let prompt = buildPrompt(input, screenText: screenText, compact: false)
        var result: (String, String)
        do {
            do {
                result = try await generateGuided(prompt)
            } catch {
                switch retryKind(for: error) {
                case .permissive: result = try await generatePlain(prompt)
                case .compact: result = try await generateGuided(buildPrompt(input, screenText: [], compact: true))
                case .none: throw error
                }
            }
        } catch {
            emit(["available": true, "error": String(describing: error)])
        }
        emit([
            "available": true,
            "title": result.0,
            "description": result.1,
            "ocrLines": screenText.count,
            "ocrMs": ocr?.ms ?? 0,
            "ocrTimedOut": ocr?.timedOut ?? false,
            "elapsedMs": Int(Date().timeIntervalSince(started) * 1000),
        ])
    }
    dispatchMain()
}
#endif
unavailable("unsupportedOS", "Apple Intelligence needs macOS 26 or later.")
