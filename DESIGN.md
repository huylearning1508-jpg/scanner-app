---
version: 1.0.0
name: ClubVAuditDesignSystem
author: V Club E-Gaming Engineering
description: Official design system for V Club Audit Scanner mobile PWA, grounded in Club V Saigon interior architecture (Nero Marquina dark marble, Crimson Red logo, Electric Cyan curved reception glow, and Champagne Gold brass).

tokens:
  colors:
    background:
      base: "#07090E"
      surface: "#0E121B"
      elevated: "#151B28"
      overlay: "rgba(7, 9, 14, 0.85)"
    brand:
      red: "#E61E38"
      redGlow: "rgba(230, 30, 56, 0.4)"
      redHover: "#FF2E4D"
    accent:
      cyan: "#00F0FF"
      cyanGlow: "rgba(0, 240, 255, 0.35)"
      cyanMuted: "#06B6D4"
    secondary:
      gold: "#D4AF37"
      amber: "#F59E0B"
      goldGlow: "rgba(212, 175, 55, 0.3)"
    status:
      success: "#10B981"
      warning: "#F59E0B"
      error: "#EF4444"
      info: "#00F0FF"
    text:
      primary: "#FFFFFF"
      secondary: "#94A3B8"
      muted: "#64748B"
      accentCyan: "#00F0FF"
      accentRed: "#FF2E4D"
      accentGold: "#F59E0B"
    borders:
      subtle: "rgba(148, 163, 184, 0.12)"
      activeCyan: "rgba(0, 240, 255, 0.4)"
      activeRed: "rgba(230, 30, 56, 0.4)"

  typography:
    fontFamilies:
      sans: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif"
      mono: "'JetBrains Mono', 'SF Mono', Consolas, Menlo, monospace"
    sizes:
      xs: "11px"
      sm: "13px"
      base: "15px"
      lg: "18px"
      xl: "22px"
      display: "28px"
    weights:
      regular: 400
      medium: 500
      semibold: 600
      bold: 700

  radii:
    sm: "6px"
    md: "10px"
    lg: "16px"
    xl: "22px"
    full: "9999px"

  shadows:
    card: "0 8px 24px rgba(0, 0, 0, 0.5)"
    cyanGlow: "0 0 20px rgba(0, 240, 255, 0.35)"
    redGlow: "0 0 20px rgba(230, 30, 56, 0.4)"
---

# V Club Audit Scanner — Design System

## 1. Brand Identity & Architectural Grounding

This design system is tailored specifically for the **V Club Audit Scanner** mobile web application (PWA), operated by slot machine technicians on the casino floor of **Club V** (Caravelle Hotel, Ho Chi Minh City).

The visual language directly reflects the physical architectural identity of Club V:
- **Nero Marquina Dark Marble (`#07090E` / `#0E121B`):** Deep obsidian backgrounds and sleek dark cards mirroring the polished dark marble columns and dim casino ambiance.
- **Club V Crimson Red (`#E61E38`):** The signature cursive red "V" neon logo, utilized for brand identity badges, active audit alerts, and critical system highlights.
- **Electric Aqua Cyan (`#00F0FF`):** Inspired by the luminous curved LED ribbon of the Club V reception desk. Provides high contrast and luminescent clarity for camera reticles, OCR metrics, and primary confirmation buttons in low-light environments.
- **Champagne Gold & Brass (`#D4AF37` / `#F59E0B`):** Inspired by the fluted decorative wall panels and metallic screens, used for audit progress indicators, session badges, and warnings.

---

## 2. Core UX & Ergonomic Principles

1. **Strict 50/50 Split-Screen Layout:**
   - **Top 50%:** Real-time Camera Viewfinder HUD with live alignment guides and camera diagnostic overlays.
   - **Bottom 50%:** High-contrast data inputs and thumb-reachable action controls.
2. **One-Thumb Operation:**
   - Technicians hold their phone in one hand while inspecting slot machines. All primary actionable triggers ("Xác nhận & Lưu", "↺ Quét lại") must remain inside the bottom 35% thumb reachable zone.
3. **High-Contrast Dark Mode:**
   - Zero pure white backgrounds. Everything uses elevated obsidian surfaces with colored neon accents to prevent operator eye fatigue during night audits.
4. **Instant Visual Feedback:**
   - Three consecutive stable frames trigger an emerald green lock indicator (`#10B981`) and a freezing visual border.

---

## 3. Screen Specifications

### Screen 1: Scanner View (Main Audit)
- **Top Bar:** Segmented tab bar with Club V red logo chip, Tab "📷 Quét" (active, cyan underline) and Tab "📊 Dữ liệu" (inactive).
- **Camera Viewfinder (Top Half):**
  - Dark liveview feed overlay.
  - Top badges: `☁ Firebase OK` and `Audit: 24/80 máy` in translucent frosted pills. Flashlight toggle button (💡).
  - Center: Sharp Electric Cyan rectangular alignment reticle with corner brackets and "KHUNG QUÉT AUDIT" tag.
  - Status toast: Emerald pill `✓ Ổn định (3 frame) — Đã khóa số`.
- **Data & Action Dock (Bottom Half):**
  - Machine No field: Large monospaced display (e.g. `078`) with green confidence badge (`100% Conf.`).
  - Dual RTP metric cards: `RTP1: 92.50%` and `RTP2: 94.15%`.
  - RAM Clear date preview: `14 / Aug / 2024`.
  - Action buttons: Compact `↺ Quét lại` on the left, wide `Xác nhận & Lưu (078) ➔` with Electric Cyan gradient glow on the right.

### Screen 2: Data & Audit Progress (Dữ liệu)
- **Top Metrics Card:** Progress meter `56 / 80 Máy đã quét (70%)` with glowing cyan/gold progress bar. Firebase sync timestamp.
- **Filter Bar:** Search input by Machine No, filter chips (`Tất cả`, `Cần kiểm tra`, `Đã chốt`), CSV export button.
- **Audit Table / Card List:** Cards for completed machines with RTP1, RTP2, Clear RAM date, and status badges.
- **Bottom Dock:** Floating button `Quay lại Quét máy tiếp theo ➔`.

### Screen 3: Low-Confidence Manual Edit (Bottom Sheet Modal)
- Dark frosted glass drawer sliding up from the bottom over the frozen slot screen.
- Warning header: Amber triangle with `Xác nhận & Chỉnh sửa số liệu`.
- Zoomed slot screen crop thumbnail for manual comparison.
- Touch-friendly large inputs for Machine No, RTP1, RTP2.
- Action buttons: `Hủy & Chụp lại` and `Lưu số đã sửa ➔`.

### Screen 4: RAM Clear Date Verification (Step 2)
- Step banner: `Bước 2 / 2: Ngày Clear RAM (Máy #078)`.
- Camera viewfinder focused on RAM clear date on slot screen.
- Touch-friendly selectors for Day, Month (pill selector), and Year.
- Action buttons: `Quay lại Bước 1` and `Hoàn thành & Lưu máy #078 ➔`.
