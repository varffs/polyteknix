// pm2 process definition for the polytunnel Pi. Deploy with:
//
//   pm2 startOrReload ecosystem.config.cjs && pm2 save
//
// NODE_ENV=production is load-bearing, not cosmetic: RTK's dev-mode
// serializable/immutable checks walk the whole state tree per action and cost
// ~157ms/action at a full history ring (measured on the Pi, 2026-07-27).
// Before this file it lived only in pm2's saved dump, so any dump rebuild
// silently dropped it and the device degraded over the following two days.
//
// .cjs, not .js: the package is "type": "module" and pm2 loads this via require().
module.exports = {
  apps: [
    {
      name: "polyteknix",
      script: "app.js",
      cwd: "/home/polyteknix/polyteknix",
      // Timestamp log lines. The 2026-07-28 push-failure investigation had
      // nothing to date the errors with except the log file's mtime.
      time: true,
      env: {
        NODE_ENV: "production",
      },
    },
  ],
};
