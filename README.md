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
- [ ] Organize interface I should have entry Welcome screen which allow select next pages /releases - already developed, /status - engine status DRAM/VRAM, /models - download models from HF, /settings - manager configuration like engine path and engine_config.ini configuration global configs and per model configs
- [ ]
- [ ] Create config for project manager_config.ini
- [ ] Add engine path to config it is our selected engine to spin up later
- [ ] List Hugging Face GGUF models
- [ ] Filter/Sort Hugging Face models
- [ ] Download Hugging Face models to ./models folder 
- [ ] Add engine configuration for llama.cpp engine in engine_config.ini file
- [ ] engine_config.ini should be configured from engine llama.cpp cli options and not directly hardcoded
- [ ] engine_config.ini should allow configure models, I select models from ./models directory and start configuration
- [ ] engine_config.ini have global config [*] and per model like [community/model-4b] each configuration I should have possibility to configure 
- [ ] Add possibility to run engine backend llama.cpp server with engine_config.init file
- [ ] Add possibility to view logs from engine backend
- [ ] View DRAM/VRAM usage