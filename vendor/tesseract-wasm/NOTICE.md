# Bundled OCR engine — provenance and licence notices

SOLIVY Finance recognises scanned GRN and supplier-bill pages with a **local** OCR engine that
ships inside the application. Nothing is installed by the user, no `PATH` entry or environment
variable is needed, and **no document, page image or recognised text leaves the machine** — the
engine is a WebAssembly build of Tesseract that runs inside SOLIVY's own Node process.

## What is in this folder

| File | Bytes | SHA-256 |
|---|---|---|
| `tesseract-core-lstm.wasm` | 2 855 361 | `66b17df6e20c5329a17ffa9c202a47eaa3e32500b253d4c7f38e7f2bc01457c3` |
| `tesseract-core-lstm.wasm.js` | 3 896 484 | `eef5f8b2f8e20e150680b20adaec4a60babafee3adbe8a94583c81fee46e8680` |
| `tessdata/eng.traineddata` | 4 113 088 | `7d4322bd2a7749724879683fc3912cb542f19906c83bcc1a52132556427170b2` |

### Engine

- **tesseract.js-core 7.0.0** — Apache License 2.0.
  Source: <https://github.com/naptha/tesseract.js-core>, commit
  `acffef2b66eb44a31df297e11d905f4b39001068`. The two files above are that repository's own
  committed build artefacts, copied unmodified.
  The build reports itself as Tesseract `5.1.0-288-g2a9c1`. The `-lstm` variant contains the LSTM
  recognition engine only (OEM 1) and no legacy engine; the non-SIMD variant is shipped because it
  runs on every WebAssembly runtime without feature detection.

### Language data

- **English `eng.traineddata`** from **tessdata_fast** — Apache License 2.0.
  Source: <https://github.com/tesseract-ocr/tessdata_fast>, commit
  `87416418657359cb625c412a48b6e1d6d41c29bd`, copied unmodified. `tessdata_fast` is the integer
  (fast) LSTM model, which matches the LSTM-only engine above.

### Components compiled into the engine

The WebAssembly build statically links the libraries below. Each one's licence text is in
`licenses/`, taken from that project's own repository.

| Component | Licence | Upstream |
|---|---|---|
| Tesseract OCR | Apache-2.0 | <https://github.com/tesseract-ocr/tesseract> |
| Leptonica | BSD-2-Clause | <https://github.com/DanBloomberg/leptonica> |
| libjpeg (IJG) | IJG licence (see `licenses/LICENSE-libjpeg.txt`, "LEGAL ISSUES") | <https://www.ijg.org/> |
| libpng | PNG Reference Library License v2 | <https://github.com/glennrp/libpng> |
| zlib | zlib licence | <https://github.com/madler/zlib> |
| libtiff | libtiff (BSD-like) licence | <https://libtiff.gitlab.io/libtiff/> |
| libwebp | BSD-3-Clause | <https://github.com/webmproject/libwebp> |
| giflib | MIT | <https://giflib.sourceforge.net/> |
| openlibm | MIT (and others — see `licenses/LICENSE-openlibm.txt`) | <https://github.com/JuliaMath/openlibm> |

All of these permit redistribution in binary form provided the copyright notice and licence text
accompany the distribution, which is what this folder does. None of them is copyleft in a way that
affects SOLIVY's own source. The Apache-2.0 components require that this NOTICE accompany the
distribution; keep this folder with the application.

## How SOLIVY uses it

`lib/grn/ocr-wasm.ts` loads `tesseract-core-lstm.wasm.js` by a path resolved from the module's own
location (never the working directory, never `PATH`), writes `tessdata/eng.traineddata` into the
engine's in-memory filesystem, and recognises each page from the image already embedded in the PDF.
The engine is created once per process and reused.

`SOLIVY_GRN_OCR_WASM_DIR` overrides this folder's location and `SOLIVY_GRN_OCR_ENGINE`
(`bundled` | `system` | `auto`) overrides which engine is used — both for advanced use only; the
defaults work with nothing configured.

## Replacing or adding a language

Drop another `*.traineddata` from `tessdata_fast` into `tessdata/` and set
`SOLIVY_GRN_OCR_LANG` (for example `eng+hin`). Add that file's licence note here if you redistribute
it.
