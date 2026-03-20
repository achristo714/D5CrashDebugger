# D5 Log Diagnostics Tool

A standalone, zero-dependency HTML tool that analyzes D5 Render log files to identify crashes, errors, and performance issues. Drag and drop a zip of your D5 logs and get an instant diagnostic report.

## How to Use

1. Open `d5-diagnostics.html` in any browser
2. Drag and drop your D5 log files or a `.zip` archive
3. Review the diagnostic report
4. Export as TXT or HTML (printable/PDF-ready)

No installation, no server, no dependencies — runs entirely in the browser.

## What It Detects

### Crash Classification

The tool automatically classifies D5 crashes into specific categories:

| Category | What It Looks For |
|----------|-------------------|
| **GPU Crash** | `DXGI_ERROR_DEVICE_HUNG`, `DXGI_ERROR_DEVICE_REMOVED`, `DXGI_ERROR_DEVICE_RESET`, D3D12 errors, GPU Breadcrumb data, Vulkan device lost |
| **Engine Crash** | `EXCEPTION_ACCESS_VIOLATION`, `Unhandled Exception`, `Fatal error`, `Assertion failed`, callstacks with `d5_immerse.exe` or `d5render_ue5` |
| **Engine Crash (Stitching)** | Crashes during panorama/image stitching — `FusionPhoto`, `CaptureActor`, `StitchingMultiPartImage` |
| **General Crashes** | `SIGSEGV`, `SIGABRT`, panics, unhandled exceptions, tracebacks |

### GPU Adapter Info

When a DXGI/GPU crash is detected, the tool extracts GPU hardware details from the log:

- **Adapter name** — e.g. NVIDIA GeForce RTX 4090, AMD Radeon RX 7900 XT
- **VRAM** — Dedicated video memory
- **Driver version**
- **D3D Feature Level**

Extracted from Unreal Engine RHI log lines (`GRHIAdapterName`, `Chosen D3D12 Adapter`, `Dedicated Video Memory`, etc.)

### Log File Types

The tool auto-detects and parses five log categories:

| Type | What It Extracts |
|------|-----------------|
| **Crash logs** | Crash events, timestamps, types, callstacks, GPU info |
| **System logs** | Structured entries with severity levels (ERROR, WARN, INFO, DEBUG) |
| **Memory logs** | Peak usage, OOM events, memory data points |
| **Network logs** | Connection errors, timeouts, DNS failures, connection refused |
| **Generic logs** | Line counts, error/warning counts, sample error lines |

### Severity Assessment

Each analysis gets an overall severity rating:

- **Critical** — Crashes or out-of-memory events detected
- **High** — More than 10 errors across log files
- **Medium** — Errors present but under 10
- **Low** — No crashes, OOM, or errors

## Report Contents

### Key Findings
Prioritized list of the most important issues found, including crash categories, OOM events, network failures, and recurring errors.

### Recommended Next Steps
Actionable guidance tailored to the specific issues found:

- **GPU crashes** — VRAM reduction steps, adapter details, recommendation to forward logs to D5 team
- **Stitching crashes** — Scene configuration issues, forward logs for reproduction
- **Engine crashes** — Callstack analysis guidance, forward logs for D5 team analysis
- **OOM events** — Memory leak investigation, peak usage stats
- **Network errors** — Service availability checks, DNS and timeout troubleshooting

### File Details
Per-file breakdown with error counts, crash details, stack traces, and timeline data.

## Supported Input

- **File types**: `.log`, `.txt`, `.out`, `.err`, `.crash`, `.dump`, `.trace`
- **Archives**: `.zip` files (automatically extracted and filtered)
- **Multiple files**: Drag and drop several files at once

D5 log timestamp formats are supported: both ISO (`2024-01-15 14:30:00`) and D5 bracket format (`[2024.01.15-14.30.00:283]`).

## Export Options

- **TXT** — Plain text report for pasting into tickets or emails
- **HTML** — Styled, print-ready report you can save as PDF from your browser

Both exports include username/path detection from log contents, summary stats, findings, next steps, and full file details.

## User Detection

The tool automatically detects the Windows/macOS/Linux username and home path from log file contents, which is included in exports for context.
