// src/views/Dashboard.jsx
import { useState, useEffect } from 'react';
import { DESIGN, TRICK_CATEGORIES, CATEGORY_ORDER } from '../config';
import { haptic } from '../utils/haptic';
import { Star, TrendingUp, Trophy, ChevronDown } from '../components/icons';
import { TrickCard } from '../components/Cards';
import { EmptyStateIllustration } from '../components/ui/EmptyState';
import { DashboardSkeleton } from '../components/Skeletons';


export const Dashboard = ({ appLoading, onSelectTrick, userTricks, tricks, favorites, onToggleFavorite }) => {
  const [filter, setFilter] = useState('todo');
  
  // Load expanded state from localStorage - default ALL collapsed for new users
  const savedTrainExpanded = localStorage.getItem('wakeway_train_expanded');
  const defaultExpanded = Object.fromEntries(CATEGORY_ORDER.map(c => [c, false]));
  const [expandedCategories, setExpandedCategories] = useState(
    savedTrainExpanded ? JSON.parse(savedTrainExpanded) : defaultExpanded
  );
  
  // Save to localStorage when changed
  const toggleCategory = (cat) => {
    setExpandedCategories(prev => {
      const newState = { ...prev, [cat]: !prev[cat] };
      localStorage.setItem('wakeway_train_expanded', JSON.stringify(newState));
      return newState;
    });
  };
  
  // Build categories dynamically from CATEGORY_ORDER
  const categories = Object.fromEntries(CATEGORY_ORDER.map(c => [c, []]));
  tricks.forEach(t => { if (categories[t.category]) categories[t.category].push(t); });
  const filteredCategories = {};
  Object.keys(categories).forEach(cat => {
    filteredCategories[cat] = categories[cat].filter(trick => {
      const ut = userTricks[trick.id];
      const status = ut?.status || 'todo'; // Default to 'todo' if no status set
      if (filter === 'all') return true;
      return status === filter;
    });
  });
  
  // Sort favorites to top in each category
  Object.keys(filteredCategories).forEach(cat => {
    filteredCategories[cat].sort((a, b) => {
      const aFav = favorites.tricks.includes(a.id);
      const bFav = favorites.tricks.includes(b.id);
      if (aFav && !bFav) return -1;
      if (!aFav && bFav) return 1;
      return 0;
    });
  });
  
  const stats = { total: tricks.length, mastered: Object.values(userTricks).filter(t => t.status === 'mastered').length, inProgress: Object.values(userTricks).filter(t => t.status === 'in_progress').length, fresh: tricks.length - Object.values(userTricks).filter(t => t.status === 'mastered').length - Object.values(userTricks).filter(t => t.status === 'in_progress').length };
  const catMeta = TRICK_CATEGORIES;
  
  const hasAnyTricks = Object.values(filteredCategories).some(arr => arr.length > 0);

  if (appLoading && tricks.length === 0) {
    return (
      <div style={{ minHeight: '100vh', background: 'transparent', paddingBottom: 100, position: 'relative', overflow: 'hidden' }}>
        <div style={{ maxWidth: 700, margin: '0 auto' }}><DashboardSkeleton /></div>
      </div>
    );
  }

  return (
    <div style={{ minHeight: '100vh', background: 'transparent', paddingBottom: 100, position: 'relative', overflow: 'hidden' }}>
      
      <div style={{ maxWidth: 700, margin: '0 auto', padding: 16, position: 'relative', zIndex: 10 }}>
        <div style={{ display: 'flex', gap: 8, marginBottom: 20 }}>
          {[{ icon: <Star size={20} color="#a78bfa" />, val: stats.fresh, label: 'New', bg: 'rgba(167,139,250,0.1)' }, { icon: <TrendingUp size={20} color="#fbbf24" />, val: stats.inProgress, label: 'Progress', bg: 'rgba(251,191,36,0.1)' }, { icon: <Trophy size={20} color="#22c55e" />, val: stats.mastered, label: 'Done', bg: 'rgba(34,197,94,0.1)' }].map((s, i) => (
            <div key={i} style={{ flex: 1, background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.06)', borderRadius: 14, padding: '10px 8px', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <div style={{ width: 32, height: 32, borderRadius: 8, background: s.bg, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>{s.icon}</div>
                <div style={{ fontSize: 20, fontWeight: 700, color: '#fff', lineHeight: 1 }}>{s.val}</div>
              </div>
              <div style={{ fontSize: 9, color: 'rgba(255,255,255,0.5)', letterSpacing: 0.5 }}>{s.label}</div>
            </div>
          ))}
        </div>
        <div style={{ display: 'flex', gap: 8, marginBottom: 24, flexWrap: 'wrap' }}>
          {['todo', 'in_progress', 'mastered', 'all'].map(f => (
            <button key={f} onClick={() => setFilter(f)} style={{ padding: '10px 18px', borderRadius: 20, fontWeight: 600, fontSize: 13, border: 'none', cursor: 'pointer', whiteSpace: 'nowrap', background: filter === f ? DESIGN.colors.primaryGradient : 'rgba(255,255,255,0.08)', color: filter === f ? '#fff' : 'rgba(255,255,255,0.6)' }}>
              {f === 'todo' ? 'New' : f === 'in_progress' ? 'Progress' : f === 'mastered' ? 'Done' : 'All'}
            </button>
          ))}
        </div>
        
        {!hasAnyTricks ? (
          <div className="fade-in" style={{ textAlign: 'center', padding: 60, color: 'rgba(255,255,255,0.5)' }}>
            <EmptyStateIllustration type="tricks" />
            <h3 style={{ fontSize: 18, fontWeight: 600, color: '#fff', marginBottom: 8, marginTop: 20 }}>No tricks yet</h3>
            <p style={{ fontSize: 14, marginBottom: 20 }}>
              {filter === 'all' ? 'Start by exploring tricks and marking your progress!' : `No tricks marked as "${filter === 'todo' ? 'New' : filter === 'in_progress' ? 'Progress' : 'Done'}"`}
            </p>
            {filter !== 'all' && (
              <button onClick={() => { haptic.light(); setFilter('all'); }} className="btn-press" style={{ padding: `${DESIGN.padding.sm}px ${DESIGN.padding.lg}px`, background: DESIGN.colors.primaryGradient, border: 'none', borderRadius: DESIGN.radius.md, color: '#fff', fontSize: 14, fontWeight: 600, cursor: 'pointer' }}>
                Show All Tricks
              </button>
            )}
          </div>
        ) : (
          Object.entries(filteredCategories).map(([cat, catTricks]) => catTricks.length > 0 && (
            <div key={cat} style={{ marginBottom: 16 }}>
              {/* Collapsible category header */}
              <button 
                onClick={() => { haptic.light(); toggleCategory(cat); }}
                className="tap-highlight"
                style={{ 
                  width: '100%', 
                  display: 'flex', 
                  alignItems: 'center', 
                  justifyContent: 'space-between',
                  gap: 10, 
                  padding: '12px 16px',
                  background: 'rgba(255,255,255,0.03)',
                  border: '1px solid rgba(255,255,255,0.08)',
                  borderBottom: expandedCategories[cat] ? 'none' : '1px solid rgba(255,255,255,0.08)',
                  borderRadius: expandedCategories[cat] ? '14px 14px 0 0' : 14,
                  cursor: 'pointer'
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                  <span style={{ fontSize: 22 }}>{catMeta[cat]?.icon}</span>
                  <h2 style={{ fontSize: 17, fontWeight: 600, color: '#fff', margin: 0 }}>{catMeta[cat]?.label}</h2>
                  <span style={{ fontSize: 12, color: 'rgba(255,255,255,0.4)' }}>({catTricks.length})</span>
                </div>
                <ChevronDown 
                  size={20} 
                  color="rgba(255,255,255,0.5)" 
                  style={{ 
                    transform: expandedCategories[cat] ? 'rotate(180deg)' : 'rotate(0deg)',
                    transition: 'transform 0.2s ease'
                  }} 
                />
              </button>
              
              {/* Collapsible content - directly connected */}
              {expandedCategories[cat] && (
                <div style={{ 
                  background: 'rgba(255,255,255,0.02)',
                  border: '1px solid rgba(255,255,255,0.08)',
                  borderTop: 'none',
                  borderRadius: '0 0 14px 14px',
                  padding: 12
                }}>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12 }}>
                    {catTricks.map(trick => (
                      <TrickCard 
                        key={trick.id} 
                        trick={trick} 
                        userTrick={userTricks[trick.id]} 
                        onClick={() => onSelectTrick(trick)}
                        isFavorite={favorites.tricks.includes(trick.id)}
                        onToggleFavorite={onToggleFavorite}
                      />
                    ))}
                  </div>
                </div>
              )}
            </div>
          ))
        )}
      </div>
    </div>
  );
};

// Article Card - matching TrickCard style

// Exports


