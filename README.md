# llama-mngr-claude

To install dependencies:

```bash
bun install
```

To run:

```bash
bun run index.ts
```

This project was created using `bun init` in bun v1.4.2. [Bun](https://bun.com) is a fast all-in-one JavaScript runtime.

## Description
Llama.cpp manager

## Interface
Page
```


          Page Here

______________________________
> [Input]
```

Dropdown
```
          Page Here
------------------------------
/cmd_1
/cmd_2    Dropdown Popup
______________________________
> /cmd [Partially filled]
```

## models.ini example
```
[*]
load-mode            = mmap
kv-unified           = 1
parallel             = 1
context-shift        = 1
flash-attn           = on
tools                = all
ui-mcp-proxy         = 1
threads              = 12
n-gpu-layers         = 99
verbose              = 1
cache-type-k         = q8_0
cache-type-v         = q8_0
reasoning-effort     = high
reasoning-budget     = 8192
sleep-idle-seconds   = 10
ctx-size             = 131072

[Sharp-Spark-X2.5-4B-Q4_K_XL]
model                = models/Sharp-Spark-X2.5-4B-Q4_K_XL.gguf

[Ling-3.0-tiny-IQ4_XS]
model                = models/Ling-3.0-tiny-IQ4_XS.gguf

[Spark-X2.5-4B-Q4_K_M]
model                = models/Spark-X2.5-4B-Q4_K_M.gguf
top-k                = -1
temperature          = 1
top-p                = 0.95

[Jackrong_Qwen3.5-4B-Neo-Q5_K_S]
model                = models/Jackrong_Qwen3.5-4B-Neo-Q5_K_S.gguf
mmproj               = mmproj/mmproj-Jackrong_Qwen3.5-4B-Neo-bf16.gguf
mmproj-offload       = 0
```

## config.init example
```
[*]
engine-path = engines/llama-b11438-bin-win-cuda-13.4-x64
```

## TODO
- [x] List releases
- [x] Read release description
- [x] List release artifacts
- [x] Filter release artifacts
- [x] Download and install artifacts to ./engines folder
- [x] Interface UI/UX
    - [x] Migrate current screen to /releases page
    - [x] Create stunning entry Welcome screen
    - [x] Create /models page - download models from HF
        - [x] List Hugging Face GGUF models
        - [x] Filter Hugging Face models
        - [x] Sort Hugging Face models: recently created/recently updated/tranding/most likes/most downloads, default: tranding
        - [x] Select model and show list of GGUF quantizations
        - [x] Download selected model GGUF quantization to ./models folder 
        - [x] Write Downloaded model to models.ini config with model name and model path
        - [x] Remove Downloaded model from ./models folder and models.ini config
    - [x] Create /settings page - manager and models configuration
        - [x] manager configuration config.ini, example attached
        - [x] engine configuration models.ini for llama.cpp engine backend, example attached
            - [x] all configs should be directly taked from `llama.cpp --help` CLI command and not directly hardcoded, because can be changed later in new engine version
    - [x] Create /status page - engine status like logs and DRAM/VRAM usage
        - [x] Show selected engine version
        - [x] Create DRAM/VRAM widget
        - [x] Add possibility to view logs from llama.cpp engine backend if engine spin up in background
    - [x] Create /start command - Run `llama.cpp serve --ui-mcp-proxy --models-dir MODELS_DIR_PATH --models-preset MODELS_INI_PATH` in background
        - [x] We run engine related with engine path in config.ini
        - [x] We do NOT kill engine backend if we close manager
    - [x] Create /stop command - kill llama.cpp serve backend