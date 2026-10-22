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

4. Restart SillyTavern. The server plugin starts its Java worker when it loads.
   Its status endpoint is `/api/plugins/languagetool/status`.
5. In SillyTavern, go to **Extensions → Install extension** and install
   [SillyTavern-LanguageTool](https://github.com/IceFog72/SillyTavern-LanguageTool).
   Reload the page and configure the extension in its settings.

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

## License

Original plugin code is licensed under the MIT License. The bundled
LanguageTool software is licensed under LGPL 2.1; see [LICENSE](./LICENSE) and
[COPYING.txt](./COPYING.txt). Some bundled LanguageTool resources and other
third-party components may have separate licenses.
