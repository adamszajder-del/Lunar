// src/config.js
// Flatwater by Lunar - Configuration & Design Tokens

// ==================== DESIGN TOKENS ====================
export const DESIGN = {
  radius: { xs: 6, sm: 8, md: 12, lg: 16, xl: 20, xxl: 24, full: 9999 },
  padding: { xs: 8, sm: 12, md: 16, lg: 20, xl: 24 },
  colors: {
    primary: '#8b5cf6',
    primaryGradient: 'linear-gradient(135deg,#8b5cf6,#a78bfa)',
    primaryGradient90: 'linear-gradient(90deg,#8b5cf6,#a78bfa)',
    avatarGradient: 'linear-gradient(135deg,#6366f1,#a78bfa)',
    secondary: '#6366f1',
    success: '#22c55e',
    warning: '#fbbf24',
    danger: '#ef4444',
    muted: '#9ca3af',
    shopGradient: 'linear-gradient(135deg,#3b82f6,#06b6d4)',
  },
  white: {
    bg: 'rgba(255,255,255,0.03)',
    bgHover: 'rgba(255,255,255,0.05)',
    border: 'rgba(255,255,255,0.08)',
    borderHover: 'rgba(255,255,255,0.15)',
    dim: 'rgba(255,255,255,0.3)',
    muted: 'rgba(255,255,255,0.5)',
    soft: 'rgba(255,255,255,0.6)',
    text: 'rgba(255,255,255,0.7)',
  },
  transition: {
    fast: 'all 0.15s ease',
    normal: 'all 0.2s ease',
    slow: 'all 0.3s ease',
  }
};

// ==================== CATEGORY METADATA ====================
export const TRICK_CATEGORIES = {
  courses:         { icon: '📖', label: 'Courses',          gradient: 'linear-gradient(135deg,#6366f1,#818cf8)', color: '#818cf8' },
  preparation:     { icon: '📚', label: 'Preparation',      gradient: 'linear-gradient(135deg,#6366f1,#8b5cf6)', color: '#8b5cf6' },
  surface:         { icon: '🌊', label: 'Surface',          gradient: 'linear-gradient(135deg,#3b82f6,#06b6d4)', color: '#06b6d4' },
  rail_obstacle:   { icon: '🛹', label: 'Rail / Obstacle',  gradient: 'linear-gradient(135deg,#10b981,#34d399)', color: '#10b981' },
  ollie:           { icon: '💨', label: 'Ollie',            gradient: 'linear-gradient(135deg,#14b8a6,#2dd4bf)', color: '#2dd4bf' },
  air:             { icon: '🚀', label: 'Air',              gradient: 'linear-gradient(135deg,#f43f5e,#fb923c)', color: '#f43f5e' },
  kicker_grabs:    { icon: '🤙', label: 'Kicker - Grabs',   gradient: 'linear-gradient(135deg,#f59e0b,#fbbf24)', color: '#fbbf24' },
  kicker_rotation: { icon: '🔄', label: 'Kicker - Rotation', gradient: 'linear-gradient(135deg,#f97316,#fb923c)', color: '#f97316' },
  kicker_invert:   { icon: '🙃', label: 'Kicker - Invert',  gradient: 'linear-gradient(135deg,#ef4444,#f87171)', color: '#ef4444' },
};

// Category display order (matches admin panel order)
export const CATEGORY_ORDER = [
  'courses', 'preparation', 'surface', 'rail_obstacle', 'ollie',
  'air', 'kicker_grabs', 'kicker_rotation', 'kicker_invert'
];

export const ARTICLE_CATEGORIES = {
  balance: { icon: '⚖️', label: 'Balance', gradient: 'linear-gradient(135deg,#3b82f6,#60a5fa)', color: '#3b82f6' },
  body: { icon: '💪', label: 'Body', gradient: 'linear-gradient(135deg,#22c55e,#4ade80)', color: '#22c55e' },
  equipment: { icon: '🛹', label: 'Equipment', gradient: 'linear-gradient(135deg,#f59e0b,#fbbf24)', color: '#f59e0b' },
  obstacle: { icon: '🎯', label: 'Obstacle', gradient: 'linear-gradient(135deg,#ef4444,#f87171)', color: '#ef4444' },
  stance: { icon: '🦶', label: 'Stance', gradient: 'linear-gradient(135deg,#8b5cf6,#a78bfa)', color: '#8b5cf6' },
  safety: { icon: '🛡️', label: 'Safety', gradient: 'linear-gradient(135deg,#06b6d4,#22d3ee)', color: '#06b6d4' }
};

export const SHOP_CATEGORIES = {
  getting_started: { icon: '🚀', label: 'Getting Started' },
  activities: { icon: '🏄', label: 'Activities' },
  practical: { icon: '📋', label: 'Practical Info' },
  groups: { icon: '👥', label: 'Groups & Events' },
  accommodation: { icon: '🏨', label: 'Accommodation' },
  contact: { icon: '📞', label: 'Contact' }
};

// ==================== API CONFIGURATION ====================
export const API_URL = 'https://lunar-production-f237.up.railway.app';

export const STRIPE_PUBLISHABLE_KEY = 'pk_test_51StcCnHb50tRNmW1Dcs4vJ8xvN2R13epSKObQcTPZ3Ar5oGMQr9upBr3s2MIiZxsOGbyMqUMmHsLXAXeHBZq3P3C00o8CWplx2';

export const TIME_SLOTS = ['09:00', '10:00', '11:00', '12:00', '13:00', '14:00', '15:00', '16:00', '17:00', '18:00'];
