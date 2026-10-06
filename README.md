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
This project allow manager llama.cpp releases, download and extract

## Interface
Page
-------------------------------
|
|
|          Page Here
|
|______________________________
|> [Input] ____________________

Dropdown
-------------------------------
|          Page Here
|------------------------------
|/cmd_1
|/cmd_2    Dropdown Popup
|______________________________
|> /cmd [Partially filled]_____

## Features
- [x] List releases
- [x] Read release description
- [x] List release artifacts
- [x] Filter release artifacts
- [x] Download and install artifacts to ./engine folder
- [ ] Interface UI/UX
    - [ ] Migrate current screen to /releases page
    - [ ] Create stunning entry Welcome screen
    - [ ] Create /status - engine status like logs and DRAM/VRAM usage
        - [ ] Create DRAM/VRAM widget
        - [ ] Add possibility to view logs from llama.cpp engine backend
    - [ ] Create /models - download models from HF
        - [ ] List Hugging Face GGUF models
        - [ ] Filter/Sort Hugging Face models
        - [ ] Download Hugging Face models to ./models folder 
    - [ ] Create /settings - manager configuration manager_config.ini
        - [ ] manager configuration manager_config.ini
            - [ ] add engine path to config it is our main llama.cpp engine backend
        - [ ] engine configuration engine_config.ini for llama.cpp engine backend
            - global configs [*] 
            - per model configs like [community/model-4b]
            - all configs should be directly taked from llama.cpp --help CLI command and not directly hardcoded, because can be changed later in new engine version