package com.streamx.app;

import com.getcapacitor.PluginCall;

/**
 * Numbers from the page, read the way the page sends them.
 *
 * `PluginCall.getLong` (Capacitor 7.6.9) returns the value only when org.json
 * stored it as a `Long` — and org.json stores every number that fits in 32 bits
 * as an `Integer`. So `getLong("timeMs", 0L)` returned 0 for every seek anyone
 * could make in a film under 24 days long, with no error anywhere:
 *
 *     page    seek({ timeMs: 300000 })          — five minutes in
 *     libVLC  seek request to i_pos = 0          — MKV
 *     libVLC  stss gives 0 --> 0 (sample number) — MP4
 *
 * Measured on the TV emulator. The same read took `startAtMs`, so a resumed
 * episode opened at 0:00 too. Reported as "cannot go
 * backwards and forwards — it just starts from the beginning" and "if you pause
 * a show and then try to restart it goes back to the beginning".
 *
 * Every whole number an argument can carry goes through here instead.
 */
final class PluginArgs {
    private PluginArgs() {}

    static long longOf(PluginCall call, String name, long fallback) {
        Object v = call.getData().opt(name);
        if (v instanceof Number) {
            double d = ((Number) v).doubleValue();
            return Double.isFinite(d) ? ((Number) v).longValue() : fallback;
        }
        if (v instanceof String) {
            try { return Long.parseLong(((String) v).trim()); } catch (NumberFormatException ignored) { /* fallback */ }
        }
        return fallback;
    }
}
