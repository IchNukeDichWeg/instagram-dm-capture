# Releasing

The version lives in one place: `manifest.json` `"version"`. The tag, the
zip name and the release title are all derived from it.

1. **Version.** Bump `manifest.json` `"version"` (semver: patch for fixes,
   minor for features). Commit.
2. **Test.** All three suites green on the commit being released:
   `node test/test.js`, `node test/hook-test.js`, `node test/e2e-test.js`.
3. **Freeze.** `scripts/build.sh` builds `dist/instagram-dm-capture-vX.Y.Z.zip`
   from the committed tree. Verify the zip itself, not the source folder:
   unzip it to a scratch dir and run `node test/e2e-test.js --ext <dir>`.
4. **Tag.** `git tag -a vX.Y.Z -m vX.Y.Z` on that commit, push `main` and
   the tag.
5. **Publish.** `gh release create vX.Y.Z dist/instagram-dm-capture-vX.Y.Z.zip
   --title "vX.Y.Z" --notes-file <notes>`. Notes: bold one-line headline,
   the fixed stats block, then short `###` sections for what this release
   changed and its known limits.
6. **Install locally.** Reload the extension in `chrome://extensions` so the
   copy in use matches what shipped.

Stats block fields, in this order:

```
Version | X.Y.Z
Tests   | <unit count> unit, hook, e2e: all passing
Tested  | <Chrome versions> / live instagram.com: <yes/no>
Zip     | <bytes> bytes, commit <short sha>
```
