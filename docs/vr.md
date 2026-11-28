# VR (beta)

You can walk through the office in a VR headset. This feature is in beta. Nobody has tested it on a real headset yet. We tested it only in an emulator. If you have a Meta Quest, please try it and tell us what happens.

- [What works](#what-works)
- [Use a Meta Quest](#use-a-meta-quest)
- [Try VR without a headset](#try-vr-without-a-headset)
- [Messages and what to do](#messages-and-what-to-do)
- [Tell us what happened](#tell-us-what-happened)

## What works

- **Enter VR** puts you in the aisle of the floor that you look at.
- You see the agents work at their desks. The name tag over each agent shows its status and what it does. In VR the name tags always show, also if you turned them off. Far tags are larger, so you can read them.
- To see which agents need you, look at your left controller. A small panel above it shows the agents that wait for you, on all floors. When a new agent starts to wait, the controllers vibrate.
- To jump to a different spot, point a controller at the floor. Hold the trigger. A ring shows where you will go. Release the trigger to go there.
- To turn 30 degrees, push a thumbstick to the left or to the right. Push it again to turn more.
- To leave VR, use the menu button of the headset.

You can jump up to 10 m. You cannot jump into furniture or through the walls. If no ring shows, point at a different part of the floor.

The office does not move you smoothly. Smooth movement makes many people sick in a headset.

These do not work yet:

- You cannot answer a permission request in VR. Take off the headset to select **Allow** or **Deny**.
- You cannot see the side panel or the toasts.

To keep the headset fast, the office has no soft shadows in VR.

## Use a Meta Quest

A headset starts VR only on a secure address. The office listens only on your computer, and it does not use HTTPS. Thus the headset must open the office at `localhost`. A USB cable does this. No data goes over your network.

Only do these steps on a headset that you own. The headset keeps the office key in its browser.

You need:

- A Meta Quest with [developer mode](https://developers.meta.com/horizon/documentation/native/android/mobile-device-setup/) on.
- A USB cable that can send data.
- `adb`, the Android tool. On a Mac, run `brew install android-platform-tools`.

Do these steps:

1. Start the office with `npm start`. Keep the link that it shows. The link starts with `http://127.0.0.1:4747/#k=`.
2. Connect the headset to your computer with the USB cable.
3. In the headset, allow USB debugging.
4. On your computer, run `adb devices`. Make sure that the headset is in the list.
5. Run `adb reverse tcp:4747 tcp:4747`. The headset can now open port 4747 of your computer as `localhost`.
6. Run `adb shell am start -a android.intent.action.VIEW -d '<the link from step 1>'`. The office opens in the browser of the headset. You do not have to type the key.
7. In the headset, select **Enter VR**.

If you use the Mac app, the steps are not tested. Use `npm start`.

If you disconnect the cable, the headset cannot open the office. Do steps 2 to 5 again.

## Try VR without a headset

The [Immersive Web Emulator](https://github.com/meta-quest/immersive-web-emulator) is an extension for Chrome. It adds a fake Quest to your browser. Use it to check a change to VR.

1. Install the extension in Chrome.
2. Open the office in Chrome on your computer.
3. Open the developer tools. Select the **WebXR** tab.
4. Select **Enter VR** in the office.
5. Move the fake headset and controllers in the **WebXR** tab.
6. To jump, point the right controller at the floor. Hold its trigger button in the **WebXR** tab, then release it.
7. To turn, move the thumbstick of a controller in the **WebXR** tab to the left or to the right.
8. To see the "Needs you" panel, turn the left controller in the **WebXR** tab toward the headset.

The emulator uses the graphics card of your computer. A headset is much slower. Thus the emulator cannot tell you if the office is fast enough in a headset.

## Messages and what to do

| Message | What to do |
|---|---|
| VR opens only from a localhost address | Open the office at `localhost` or `127.0.0.1`. On a headset, use the USB steps above. |
| This browser cannot show VR | Open the office in the browser of the headset. Or use the emulator. |
| No VR headset found | Connect the headset with the USB cable. Then open the office in the browser of the headset. |
| The headset did not start VR | Put on the headset. Then select **Enter VR** again. |

## Tell us what happened

[Open an issue](https://github.com/regisBafutwabo/agent-office/issues) and tell us:

- The headset model.
- If VR started.
- If the view was smooth or not.
- If you felt sick.
- Which text was too small to read.
