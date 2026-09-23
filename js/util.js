/**
 * util.js — tiện ích rung (haptic) và tiếng bíp, dùng Web API chuẩn.
 */

const HapticUtil = (() => {
    function vibrate(ms) {
        try {
            if (navigator.vibrate) navigator.vibrate(ms);
        } catch (e) { /* thiết bị/trình duyệt không hỗ trợ (vd Safari iOS) — bỏ qua */ }
    }
    return {
        vibrateTick: () => vibrate(40),
        vibrateConfirm: () => vibrate(80)
    };
})();

const BeepUtil = (() => {
    let audioCtx = null;

    function playBeep() {
        try {
            audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
            if (audioCtx.state === 'suspended') audioCtx.resume();
            const osc = audioCtx.createOscillator();
            const gain = audioCtx.createGain();
            osc.type = 'sine';
            osc.frequency.value = 1200;
            gain.gain.setValueAtTime(0.2, audioCtx.currentTime);
            gain.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + 0.15);
            osc.connect(gain).connect(audioCtx.destination);
            osc.start();
            osc.stop(audioCtx.currentTime + 0.15);
        } catch (e) {
            console.error('Không thể phát tiếng bíp', e);
        }
    }

    return { playBeep };
})();
