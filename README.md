# LanguageTool Server Plugin for SillyTavern

This is the **server-side** part of the LanguageTool integration. It runs
LanguageTool locally and exposes the API used by the
[LanguageTool SillyTavern extension](https://github.com/IceFog72/SillyTavern-LanguageTool).
Install both projects to use grammar checking in SillyTavern: this plugin alone
does not add a user interface.

## Requirements

- SillyTavern with server plugins enabled.
- Java 17 or newer available on the server's `PATH`.
- Git LFS installed before installing this repository. The language-detection
  model is stored with Git LFS.
- Auto-detect uses the bundled `bin/fasttext` binary, which is built for Linux
  x86-64. On other systems choose explicit languages in the extension settings.

Check Java with `java -version` and Git LFS with `git lfs version`.

## Install

1. Install Git LFS on the machine running SillyTavern, then run `git lfs install`
   once. Without that step Git clones only a small pointer file instead of the model.
2. From the SillyTavern installation directory, install this server plugin:

   ```sh
   node plugins.js install https://github.com/IceFog72/SillyTavern-LanguageToolPlugin.git
   ```

   You can also clone this repository into SillyTavern's `plugins` directory.
   Make sure the Git LFS model is downloaded; `bin/lid.176.bin` should be a
   large binary file, not a short text pointer.

3. Open SillyTavern's `config.yaml` and set:

   ```yaml
   enableServerPlugins: true
   ```

4. Restart SillyTavern. The plugin loads at once and starts its Java worker in
   the background, so the first check can take a few seconds. A broken install
   does not stop SillyTavern from starting.
5. In SillyTavern, go to **Extensions → Install extension** and install
   [SillyTavern-LanguageTool](https://github.com/IceFog72/SillyTavern-LanguageTool).
   Reload the page and configure the extension in its settings.

## Troubleshooting

On every start the plugin checks its files: the LanguageTool jars, the
`bin/fasttext` binary, and the size and SHA-256 checksum of `bin/lid.176.bin`.
Each problem is logged as `[LanguageTool] Install problem: ...` with the command
that fixes it, and listed in `installProblems` from the status endpoint.

If the model is still a Git LFS pointer, run this in the plugin folder and
restart SillyTavern:

```sh
git lfs install --local
git lfs pull
```

If the status endpoint reports another error, check the SillyTavern server log
and confirm Java is installed.

## Languages

- **Auto-detect** (`auto`) picks the language with fastText. If the model or
  binary is unusable, explicit languages keep working and auto checks return
  an error that says why.
- **Language without a region** (`en`, `de`, `pt`) is checked with
  LanguageTool's default variant (`en-US`, `de-DE`, `pt-PT`), because only
  variants have a spell checker. Pick the exact variant you write in for the
  best results.
- **Several languages** (up to 8) are for mixed-language text. A word is
  flagged as misspelled only when none of the selected languages knows it, and
  an issue found by more than one language is reported once.

## API

Routes are under `/api/plugins/languagetool` and use SillyTavern's CSRF
protection.

`GET /status` starts the worker if it is not running and returns `200` when it
is ready, otherwise `503`:

| Field | Meaning |
| --- | --- |
| `ok` | The worker is running and can check text. |
| `workerAlive` | The Java worker process is running. |
| `workerError` | Why the worker could not start, with the end of its error output. |
| `autoDetect` | Auto-detect is available. |
| `autoDetectError` | Why auto-detect is off. |
| `installProblems` | Problems found by the file check, each with a fix. Empty when the install is complete. |

`POST /check` takes `{ "text": "...", "languages": ["en-US"] }` and returns
`{ "matches": [...] }`. Each match has `offset`, `length`, `message`,
`shortMessage`, `replacements` (`[{ "value": "..." }]`) and `rule`
(`{ "id", "issueType" }`, where `issueType` is `misspelling` or `grammar`).
Text is limited to 100000 characters. A check that runs longer than 30 seconds
fails, and the worker is restarted.

## Development

Run the tests from the plugin folder with Node 20 or newer and Java on `PATH`:

```sh
node --test tests/*.test.mjs
```

The tests start real Java workers, so a full run takes about a minute. Tests
that need the real fastText model check for it and adapt.

## License

Original plugin code is licensed under the MIT License. The bundled
LanguageTool software is licensed under LGPL 2.1; see [LICENSE](./LICENSE) and
[COPYING.txt](./COPYING.txt). Some bundled LanguageTool resources and other
third-party components may have separate licenses.
