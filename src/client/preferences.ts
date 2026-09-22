export interface Preferences {
  name: string;
  effects: boolean;
  sound: boolean;
  reduced: boolean;
}
const defaults: Preferences = {
  name: "",
  effects: true,
  sound: true,
  reduced: false,
};
export function readPreferences(): Preferences {
  try {
    const raw = document.cookie
      .split("; ")
      .find((c) => c.startsWith("ink_chess_preferences="))
      ?.split("=")
      .slice(1)
      .join("=");
    if (!raw) return defaults;
    const p = JSON.parse(decodeURIComponent(raw));
    return {
      name: typeof p.name === "string" ? p.name : "",
      effects: typeof p.effects === "boolean" ? p.effects : true,
      sound: typeof p.sound === "boolean" ? p.sound : true,
      reduced: typeof p.reduced === "boolean" ? p.reduced : false,
    };
  } catch {
    return defaults;
  }
}
export function savePreferences(p: Preferences) {
  document.cookie = `ink_chess_preferences=${encodeURIComponent(JSON.stringify(p))}; Path=/; Max-Age=31536000; SameSite=Strict${location.protocol === "https:" ? "; Secure" : ""}`;
}
let audio: AudioContext | undefined;
export function unlockAudio() {
  try {
    audio ??= new AudioContext();
    void audio.resume();
  } catch {
    /* Audio is optional. */
  }
}
export function playMove(capture: boolean) {
  if (!audio || audio.state !== "running") return;
  const oscillator = audio.createOscillator(),
    gain = audio.createGain(),
    now = audio.currentTime;
  oscillator.type = "sine";
  oscillator.frequency.setValueAtTime(capture ? 180 : 420, now);
  oscillator.frequency.exponentialRampToValueAtTime(90, now + 0.12);
  gain.gain.setValueAtTime(0.12, now);
  gain.gain.exponentialRampToValueAtTime(0.001, now + 0.15);
  oscillator.connect(gain);
  gain.connect(audio.destination);
  oscillator.start(now);
  oscillator.stop(now + 0.16);
}
