import { useSettingsStore } from "../stores/settings";

type AudioContextWindow = Window &
  typeof globalThis & {
    webkitAudioContext?: typeof AudioContext;
  };

let notificationAudioContext: AudioContext | null = null;
let customNotificationAudio: HTMLAudioElement | null = null;

const playDefaultNotificationBell = () => {
  const AudioContextCtor =
    window.AudioContext ?? (window as AudioContextWindow).webkitAudioContext;
  if (!AudioContextCtor) return;

  try {
    notificationAudioContext ??= new AudioContextCtor();
    const ctx = notificationAudioContext;

    const ring = () => {
      const now = ctx.currentTime;
      const gain = ctx.createGain();
      const first = ctx.createOscillator();
      const second = ctx.createOscillator();

      gain.gain.setValueAtTime(0.0001, now);
      gain.gain.exponentialRampToValueAtTime(0.08, now + 0.015);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.34);
      gain.connect(ctx.destination);

      first.type = "sine";
      first.frequency.setValueAtTime(880, now);
      first.connect(gain);
      first.start(now);
      first.stop(now + 0.16);

      second.type = "sine";
      second.frequency.setValueAtTime(1174.66, now + 0.18);
      second.connect(gain);
      second.onended = () => gain.disconnect();
      second.start(now + 0.18);
      second.stop(now + 0.34);
    };

    if (ctx.state === "suspended") {
      ctx.resume().then(ring).catch(() => {});
    } else {
      ring();
    }
  } catch {
    // Audio can be unavailable before a user gesture or in restricted webviews.
  }
};

export const playNotificationSound = () => {
  const { enableNotificationSound, notificationSoundDataUrl } = useSettingsStore.getState();
  if (!enableNotificationSound) return;

  if (notificationSoundDataUrl) {
    try {
      customNotificationAudio?.pause();
      customNotificationAudio = new Audio(notificationSoundDataUrl);
      customNotificationAudio.onended = () => {
        customNotificationAudio = null;
      };
      customNotificationAudio.play().catch(playDefaultNotificationBell);
      return;
    } catch {
      playDefaultNotificationBell();
      return;
    }
  }

  playDefaultNotificationBell();
};
