# Stillblade friends playtest

## Match and audio

1. Make a private room with bot fill off. Put the same number of people on each team. Play both maps and stay through the side switch so the same people try ghosts and defenders. Keep bot-only and mixed-room results separate from all-human matches.
2. For each round, note the map, faction that won, how the round ended, plant attempts and completions, defuses, and where players first met. Match logs record completed objectives and round outcomes. Someone playing or observing should note abandoned attempts and routes players did not find.
3. Ask a new ghost to explain when defenders can see and hear them. Try dropping the bomb and having another ghost pick it up. Ask a new defender to locate an unseen ghost before firing. In Warehouse, test equal-distance cues on the same floor and from another floor, first in quiet and then with other players shooting.
4. Ask people to note their ping and any freeze, silent hit, confusing sound or missed match prompt. For each report, note the map, phase, role, and what the player did immediately before it happened. Verify lobby, reconnect, and side swap once across two different networks.

## Laptop performance

1. Use the target laptop with integrated graphics, plugged in. Record the laptop model, GPU, browser/version, power mode and display refresh rate. Start with Low graphics and a 1280 × 720 browser viewport. Use the same viewport on both runs.
2. Open the game with `?perf=1&tier=low` before joining. Use Warehouse with up to ten players. Bots are fine for this part. Once the map and assets are ready, click **Start** on the performance panel. You have four seconds to return to play. Run through a busy route with gunfire and effects. Leave the tab visible and window size fixed for 30 seconds.
3. Press Esc when needed to release the pointer and click **Download results**. The file stays local and includes average frame rate, p50/p95/p99 frame times, frames over 50 ms, minimum and average render scale, average draw calls, and viewport size. It also records the browser's reported renderer when available. A renderer reported as software is not a hardware result.
4. Repeat in the same scene with `&aa=0` added to the URL, on the same laptop. Compare p95/p99, hitches and render scale alongside the average frame rate. For a fixed-pixel comparison, repeat both runs with `&res=1`. Repeat on Training Yard to check whether a problem is map-specific. If you use an invite URL, append these options with `&` so the room code stays in the link.
5. At 60 FPS each frame has about 16.7 ms. Look for sustained performance close to 60 FPS in Low, and report how far the game lowered the resolution to get there. A high average can hide pauses, so report p95/p99 and hitch counts even when the average looks good.

The panel measures time between rendered updates from the browser clock, including visible stalls. It cancels if the tab becomes hidden, the viewport resizes, or the map or tier changes. Treat the numbers as whole-frame timing. Use the browser performance profiler to distinguish CPU work from GPU rendering after a slow case is repeatable.
