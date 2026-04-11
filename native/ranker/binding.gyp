{
  "targets": [{
    "target_name": "pikly_ranker",
    "sources": [
      "src/addon.cc",
      "src/ranker.cc"
    ],
    "include_dirs": [
      "src",
      "<!@(node -p \"require('node-addon-api').include\")"
    ],
    "defines": [
      "NAPI_DISABLE_CPP_EXCEPTIONS"
    ],
    "cflags_cc": [
      "-std=c++17",
      "-O3",
      "-march=native",
      "-funroll-loops",
      "-ffast-math"
    ],
    "xcode_settings": {
      "CLANG_CXX_LANGUAGE_STANDARD": "c++17",
      "GCC_OPTIMIZATION_LEVEL": "3",
      "OTHER_CFLAGS": ["-ffast-math"]
    },
    "msvs_settings": {
      "VCCLCompilerTool": {
        "AdditionalOptions": ["/std:c++17", "/O2"]
      }
    }
  }]
}
