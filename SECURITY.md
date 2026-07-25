# Security notes

## iotplotter API key

The iotplotter feed api-key is now loaded from the environment
(`process.env.IOTPLOTTER_KEY`, via a gitignored `.env` — see `.env.example`).
It is no longer hardcoded in source.

### ⚠️ Action still required: rotate the old key

An earlier version (`redux-build.js`, now removed) hardcoded a live api-key
that was committed to this repository's **public git history**. Removing the
file from the working tree does **not** remove it from history — the old key
remains retrievable from past commits on the public remote.

- **Treat the old key as compromised.** Rotate it at iotplotter.com and put the
  new value in `.env`.
- History was intentionally **not** scrubbed (low-sensitivity feed, decision
  deferred). If you later want it gone from history, use `git filter-repo`
  (or BFG) with a replace-text rule and force-push — note this rewrites all
  commit SHAs on the public remote.

`.env` is gitignored; never commit real keys.
