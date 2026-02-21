// src/views/Profile.jsx
import { useState, useEffect, useRef, useCallback } from 'react';
import { DESIGN, TRICK_CATEGORIES, CATEGORY_ORDER } from '../config';
import { api } from '../api';
import { haptic } from '../utils/haptic';
import { showToast } from '../utils/toast';
import { useAuth } from '../hooks/useAuth';
import { Trophy, Star, Award, Camera, Edit, ChevronRight, ChevronLeft, ChevronDown, X, Check, LogOut, Lock, Trash, TrendingUp, Heart, MessageCircle, Clock } from '../components/icons';
import { TIER_COLORS, TIER_LABELS } from '../constants/tiers';
import { UserRoleBadges } from '../components/ui/Badge';
import { AchievementsGrid, AchievementCard } from '../components/Cards';
import { AchievementModal } from '../components/Modals';
import { CommentsModal } from '../components/CommentsModal';
import { ProfileSkeleton } from '../components/Skeletons';
import { getTimeAgo } from '../utils/time';


export const ProfileView = ({ appLoading, onLogout, onUpdateAvatar, onUpdateProfile, userTricks = {}, userArticleStatus = {}, onBack, registeredEvents = [], userBookings = [], crew = [], tricks = [] }) => {
  const { user } = useAuth();
  const [achievementsFilter, setAchievementsFilter] = useState('achieved');
  const [achievements, setAchievements] = useState(null);
  const [achievementsStats, setAchievementsStats] = useState({ earned: 0, total: 11, special: 0, streak: 0 });
  const [expandedAchievements, setExpandedAchievements] = useState(false);
  const [showEditModal, setShowEditModal] = useState(false);
  const [selectedAchievement, setSelectedAchievement] = useState(null);
  const [editEmail, setEditEmail] = useState(user?.email || '');
  const [editPassword, setEditPassword] = useState('');
  const [editConfirmPassword, setEditConfirmPassword] = useState('');
  const [isUploadingAvatar, setIsUploadingAvatar] = useState(false);
  const fileInputRef = useRef(null);
  
  // Reactions state for own profile
  const [trickReactions, setTrickReactions] = useState({});
  const [achievementReactions, setAchievementReactions] = useState({});
  const [expandedTricks, setExpandedTricks] = useState({});
  const [expandedCategories, setExpandedCategories] = useState({});
  const [expandedMasteredTricks, setExpandedMasteredTricks] = useState(false);
  const [expandedHistory, setExpandedHistory] = useState(false);
  const [myFeed, setMyFeed] = useState([]);
  const [newComment, setNewComment] = useState('');
  const [commentingOn, setCommentingOn] = useState(null);
  
  // Comment modal state (Instagram-style)
  const [commentModal, setCommentModal] = useState({ isOpen: false, type: null, id: null, comments: [], isLoading: false });
  
  const openCommentModal = (type, id, comments = []) => {
    setCommentModal({ isOpen: true, type, id, comments, isLoading: false });
  };
  
  const closeCommentModal = () => {
    setCommentModal({ isOpen: false, type: null, id: null, comments: [], isLoading: false });
  };

  // Fetch achievements
  useEffect(() => {
    const fetchAchievements = async () => {
      try {
        const res = await api.get('/api/achievements/my');
        if (res) {
          setAchievements(res.achievements);
          setAchievementsStats(res.stats);
        }
      } catch (err) {
        console.error('Failed to fetch achievements:', err);
      }
    };
    fetchAchievements();
  }, []);
  
  // Fetch reactions for own profile
  useEffect(() => {
    const fetchReactions = async () => {
      if (!user?.id) return;
      
      // Fetch trick reactions
      try {
        const tricksRes = await api.get(`/api/users/${user.id}/tricks/reactions`);
        if (tricksRes) {
          const reactionsMap = {};
          tricksRes.forEach(r => {
            reactionsMap[r.trick_id] = {
              comments: r.comments || [],
              likesCount: r.likes_count || 0,
              commentsCount: r.comments_count || 0,
              userLiked: r.user_liked || false
            };
          });
          setTrickReactions(reactionsMap);
        }
      } catch (e) { /* silent */ }
      
      // Fetch achievement reactions
      try {
        const achRes = await api.get(`/api/users/${user.id}/achievements/reactions`);
        if (achRes) {
          const achMap = {};
          achRes.forEach(r => {
            achMap[r.achievement_id] = {
              comments: r.comments || [],
              likesCount: r.likes_count || 0,
              commentsCount: r.comments_count || 0,
              userLiked: r.user_liked || false
            };
          });
          setAchievementReactions(achMap);
        }
      } catch (e) { /* silent */ }
    };
    fetchReactions();
  }, [user?.id]);

  // Fetch own activity feed (History)
  useEffect(() => {
    const fetchMyFeed = async () => {
      if (!user?.id) return;
      try {
        const res = await api.get(`/api/users/${user.id}/activity`);
        if (res?.items) setMyFeed(res.items);
      } catch (e) { /* silent - endpoint may not exist yet */ }
    };
    fetchMyFeed();
  }, [user?.id]);

  // Calculate stats
  const trickStats = {
    mastered: Object.values(userTricks).filter(t => t.status === 'mastered').length,
    inProgress: Object.values(userTricks).filter(t => t.status === 'in_progress').length,
    total: Object.keys(userTricks).length
  };

  const articleStats = {
    read: Object.values(userArticleStatus).filter(s => s === 'known').length,
    toRead: Object.values(userArticleStatus).filter(s => s === 'to_read').length,
    total: Object.keys(userArticleStatus).length
  };

  // Events stats - combine registered events and bookings
  const eventsCount = registeredEvents.length + userBookings.length;

  const handleAvatarChange = async (e) => {
    const file = e.target.files?.[0];
    if (file) {
      setIsUploadingAvatar(true);
      const reader = new FileReader();
      reader.onload = async (ev) => {
        const base64 = ev.target?.result;
        if (base64) {
          await onUpdateAvatar(base64);
          showToast('Avatar updated!');
          // Check profile_pro achievement
          try { await api.post('/api/achievements/check'); } catch (e) {}
          setTimeout(() => {
            window.location.reload();
          }, 500);
        }
      };
      reader.readAsDataURL(file);
    }
  };

  const handleSaveProfile = async () => {
    if (editPassword && editPassword !== editConfirmPassword) {
      showToast('Passwords do not match', 'error');
      return;
    }
    if (onUpdateProfile) {
      await onUpdateProfile({ email: editEmail, password: editPassword || undefined });
    }
    setShowEditModal(false);
    setEditPassword('');
    setEditConfirmPassword('');
    showToast('Profile updated!');
  };

  // Reaction handlers for own profile
  const handleLike = async (trickId) => {
    if (!user) return;
    try {
      const res = await api.post(`/api/users/${user.id}/tricks/${trickId}/like`);
      if (res) {
        setTrickReactions(prev => ({
          ...prev,
          [trickId]: { ...prev[trickId], likesCount: res.likes_count, userLiked: res.user_liked }
        }));
        haptic.light();
      }
    } catch (err) { console.error('Failed to toggle like:', err); }
  };
  
  const handleCommentLike = async (trickId, commentId) => {
    if (!user) return;
    try {
      const res = await api.post(`/api/users/${user.id}/tricks/${trickId}/comments/${commentId}/like`);
      if (res) {
        const updateComments = (comments) => comments?.map(c => c.id === commentId ? { ...c, likes_count: res.likes_count, user_liked: res.user_liked } : c) || [];
        setTrickReactions(prev => ({
          ...prev,
          [trickId]: {
            ...prev[trickId],
            comments: updateComments(prev[trickId]?.comments)
          }
        }));
        // Update modal
        if (commentModal.isOpen && commentModal.type === 'trick' && commentModal.id === trickId) {
          setCommentModal(prev => ({ ...prev, comments: updateComments(prev.comments) }));
        }
        haptic.light();
      }
    } catch (err) { console.error('Failed to toggle comment like:', err); }
  };
  
  const handleDeleteComment = async (trickId, commentId) => {
    if (!user) return;
    try {
      await api.delete(`/api/users/${user.id}/tricks/${trickId}/comments/${commentId}`);
      const filterComments = (comments) => comments?.filter(c => c.id !== commentId) || [];
      setTrickReactions(prev => ({
        ...prev,
        [trickId]: {
          ...prev[trickId],
          comments: filterComments(prev[trickId]?.comments),
          commentsCount: Math.max(0, (prev[trickId]?.commentsCount || 1) - 1)
        }
      }));
      // Update modal
      if (commentModal.isOpen && commentModal.type === 'trick' && commentModal.id === trickId) {
        setCommentModal(prev => ({ ...prev, comments: filterComments(prev.comments) }));
      }
      showToast('Comment deleted');
      haptic.light();
    } catch (err) { console.error('Failed to delete comment:', err); }
  };
  
  const handleAddComment = async (trickId) => {
    if (!user || !newComment.trim()) return;
    try {
      const res = await api.post(`/api/users/${user.id}/tricks/${trickId}/comment`, { content: newComment.trim() });
      if (res) {
        setTrickReactions(prev => ({
          ...prev,
          [trickId]: {
            ...prev[trickId],
            comments: [...(prev[trickId]?.comments || []), res],
            commentsCount: (prev[trickId]?.commentsCount || 0) + 1
          }
        }));
        setNewComment('');
        setCommentingOn(null);
        showToast('Comment added!');
        haptic.success();
      }
    } catch (err) { console.error('Failed to add comment:', err); }
  };
  
  // For modal use - accepts content directly
  const handleAddTrickComment = async (trickId, content) => {
    if (!user || !content.trim()) return;
    try {
      const res = await api.post(`/api/users/${user.id}/tricks/${trickId}/comment`, { content: content.trim() });
      if (res) {
        setTrickReactions(prev => ({
          ...prev,
          [trickId]: {
            ...prev[trickId],
            comments: [...(prev[trickId]?.comments || []), res],
            commentsCount: (prev[trickId]?.commentsCount || 0) + 1
          }
        }));
        // Update modal
        if (commentModal.isOpen && commentModal.type === 'trick' && commentModal.id === trickId) {
          setCommentModal(prev => ({ ...prev, comments: [...prev.comments, res] }));
        }
        showToast('Comment added!');
        haptic.success();
      }
    } catch (err) { console.error('Failed to add comment:', err); }
  };
  
  const handleAchievementLike = async (achievementId) => {
    if (!user) return;
    try {
      const res = await api.post(`/api/users/${user.id}/achievements/${achievementId}/like`);
      if (res) {
        setAchievementReactions(prev => ({
          ...prev,
          [achievementId]: { ...prev[achievementId], likesCount: res.likes_count, userLiked: res.user_liked }
        }));
        haptic.light();
      }
    } catch (err) { console.error('Failed to toggle achievement like:', err); }
  };
  
  const handleAchievementCommentLike = async (achievementId, commentId) => {
    if (!user) return;
    try {
      const res = await api.post(`/api/users/${user.id}/achievements/${achievementId}/comments/${commentId}/like`);
      if (res) {
        const updateComments = (comments) => comments?.map(c => c.id === commentId ? { ...c, likes_count: res.likes_count, user_liked: res.user_liked } : c) || [];
        
        setAchievementReactions(prev => ({
          ...prev,
          [achievementId]: {
            ...prev[achievementId],
            comments: updateComments(prev[achievementId]?.comments)
          }
        }));
        
        // Update modal if open
        if (commentModal.isOpen && commentModal.type === 'achievement' && commentModal.id === achievementId) {
          setCommentModal(prev => ({ ...prev, comments: updateComments(prev.comments) }));
        }
        
        haptic.light();
      }
    } catch (err) { console.error('Failed to toggle achievement comment like:', err); }
  };
  
  const handleDeleteAchievementComment = async (achievementId, commentId) => {
    if (!user) return;
    try {
      await api.delete(`/api/users/${user.id}/achievements/${achievementId}/comments/${commentId}`);
      
      const filterComments = (comments) => comments?.filter(c => c.id !== commentId) || [];
      
      setAchievementReactions(prev => ({
        ...prev,
        [achievementId]: {
          ...prev[achievementId],
          comments: filterComments(prev[achievementId]?.comments),
          commentsCount: Math.max(0, (prev[achievementId]?.commentsCount || 1) - 1)
        }
      }));
      
      // Update modal if open
      if (commentModal.isOpen && commentModal.type === 'achievement' && commentModal.id === achievementId) {
        setCommentModal(prev => ({ ...prev, comments: filterComments(prev.comments) }));
      }
      
      showToast('Comment deleted');
      haptic.light();
    } catch (err) { console.error('Failed to delete comment:', err); }
  };
  
  const handleAddAchievementComment = async (achievementId, content) => {
    const commentContent = content || newComment.trim();
    if (!user || !commentContent) return;
    try {
      const res = await api.post(`/api/users/${user.id}/achievements/${achievementId}/comment`, { content: commentContent });
      if (res) {
        setAchievementReactions(prev => ({
          ...prev,
          [achievementId]: {
            ...prev[achievementId],
            comments: [...(prev[achievementId]?.comments || []), res],
            commentsCount: (prev[achievementId]?.commentsCount || 0) + 1
          }
        }));
        
        // Update modal if open
        if (commentModal.isOpen && commentModal.type === 'achievement' && commentModal.id === achievementId) {
          setCommentModal(prev => ({ ...prev, comments: [...prev.comments, res] }));
        }
        
        setNewComment('');
        setCommentingOn(null);
        showToast('Comment added!');
        haptic.success();
      }
    } catch (err) { console.error('Failed to add comment:', err); }
  };
  
  const navigateToUserProfile = (userId) => {
    // In own profile, we can't navigate to crew - this is placeholder
    // silent;
  };
  
  const toggleCategory = (cat) => {
    setExpandedCategories(prev => ({ ...prev, [cat]: !prev[cat] }));
  };
  
  const toggleTrickComments = (trickId) => {
    setExpandedTricks(prev => ({ ...prev, [trickId]: !prev[trickId] }));
  };

  // Use global tier colors and labels
  const tierColors = TIER_COLORS;
  const tierLabels = TIER_LABELS;

  // Filter achievements
  const filteredAchievements = achievements ? Object.values(achievements).filter(a => {
    if (achievementsFilter === 'before_me') return (a.progress || 0) === 0;
    if (achievementsFilter === 'achieved') return a.currentTier !== null;
    return false;
  }) : [];

  // Achievement Detail Modal
  if (selectedAchievement) {
    const a = selectedAchievement;
    const tc = tierColors[a.currentTier] || { bg: 'rgba(255,255,255,0.05)', border: 'rgba(255,255,255,0.1)', text: 'rgba(255,255,255,0.4)' };
    
    return (
      <div style={{ minHeight: '100vh', background: 'transparent', paddingBottom: 100, position: 'relative' }}>
        <div style={{ maxWidth: 700, margin: '0 auto', padding: 16, position: 'relative', zIndex: 10 }}>
          <button onClick={() => setSelectedAchievement(null)} style={{ display: 'flex', alignItems: 'center', gap: 8, background: 'none', border: 'none', color: 'rgba(255,255,255,0.6)', fontSize: 14, cursor: 'pointer', marginBottom: 20, padding: 0 }}>
            <ChevronLeft size={20} /> Back
          </button>
          
          <div style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.08)', borderRadius: DESIGN.radius.xxl, overflow: 'hidden' }}>
            {/* Two-column header like Calendar events */}
            <div style={{ padding: 20 }}>
              <div style={{ display: 'flex', gap: 12 }}>
                {/* Achievement info box */}
                <div style={{ flex: 1, display: 'flex', alignItems: 'center', gap: 14, padding: 16, background: tc.bg, borderRadius: 16, border: `1px solid ${tc.border}` }}>
                  <div style={{ width: 52, height: 52, borderRadius: 14, background: 'rgba(0,0,0,0.2)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 28 }}>
                    {a.icon}
                  </div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <h1 style={{ fontSize: 17, fontWeight: 700, color: '#fff', margin: 0, marginBottom: 6 }}>{a.name}</h1>
                    {a.currentTier && (
                      <span style={{ display: 'inline-block', padding: '4px 12px', background: 'rgba(0,0,0,0.2)', border: `1px solid ${tc.border}`, borderRadius: 12, fontSize: 11, fontWeight: 700, color: tc.text, textTransform: 'uppercase' }}>
                        {tierLabels[a.currentTier]}
                      </span>
                    )}
                  </div>
                </div>
                
                {/* Progress box (only for automatic achievements) */}
                {a.type === 'automatic' && a.tiers && (
                  <div style={{ width: 100, padding: 16, background: 'rgba(139,92,246,0.1)', borderRadius: 16, border: '1px solid rgba(139,92,246,0.2)', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center' }}>
                    <div style={{ fontSize: 22, fontWeight: 700, color: '#a78bfa', marginBottom: 2 }}>{a.progress || 0}</div>
                    <div style={{ fontSize: 10, color: 'rgba(255,255,255,0.5)', textTransform: 'uppercase', fontWeight: 600 }}>Progress</div>
                    {/* Mini progress bar */}
                    {a.nextTierThreshold && (
                      <div style={{ width: '100%', height: 4, background: 'rgba(255,255,255,0.1)', borderRadius: 2, marginTop: 8, overflow: 'hidden' }}>
                        <div style={{ height: '100%', width: `${Math.min((a.progress / a.nextTierThreshold) * 100, 100)}%`, background: '#a78bfa', borderRadius: 2 }} />
                      </div>
                    )}
                  </div>
                )}
              </div>
            </div>
            
            {/* Content */}
            <div style={{ padding: 24 }}>
              {/* Progress for automatic achievements */}
              {a.type === 'automatic' && a.tiers && (
                <div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                    {Object.entries(a.tiers).map(([tier, threshold]) => {
                      const isEarned = a.progress >= threshold;
                      const tc2 = tierColors[tier];
                      return (
                        <div key={tier} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: 12, background: isEarned ? tc2.bg : 'rgba(255,255,255,0.03)', border: `1px solid ${isEarned ? tc2.border : 'rgba(255,255,255,0.08)'}`, borderRadius: 12 }}>
                          <div style={{ width: 28, height: 28, borderRadius: '50%', background: isEarned ? tc2.bg : 'rgba(255,255,255,0.05)', border: `2px solid ${isEarned ? tc2.text : 'rgba(255,255,255,0.2)'}`, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                            {isEarned && <Check size={14} color={tc2.text} />}
                          </div>
                          <div style={{ flex: 1 }}>
                            <span style={{ fontSize: 13, fontWeight: 600, color: isEarned ? tc2.text : 'rgba(255,255,255,0.5)' }}>{tierLabels[tier]}</span>
                          </div>
                          <span style={{ fontSize: 13, color: isEarned ? tc2.text : 'rgba(255,255,255,0.4)' }}>{threshold}</span>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}
              
              {/* Manual achievement info */}
              {a.type === 'manual' && (
                <div style={{ textAlign: 'center', padding: 20, background: 'rgba(0,206,209,0.1)', border: '1px solid rgba(0,206,209,0.2)', borderRadius: 12 }}>
                  <Star size={32} color="#00CED1" style={{ marginBottom: 12 }} />
                  <p style={{ fontSize: 14, color: 'rgba(255,255,255,0.7)' }}>
                    {a.currentTier ? 'You have earned this special achievement!' : 'This special achievement is awarded by Lunar staff for participation in special events.'}
                  </p>
                  {a.achievedAt && (
                    <p style={{ fontSize: 12, color: 'rgba(255,255,255,0.5)', marginTop: 8 }}>
                      Awarded: {new Date(a.achievedAt).toLocaleDateString()}
                    </p>
                  )}
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    );
  }

  if (appLoading && !user) {
    return (
      <div style={{ minHeight: '100vh', background: 'transparent', paddingBottom: 100, position: 'relative' }}>
        <div style={{ maxWidth: 700, margin: '0 auto' }}><ProfileSkeleton /></div>
      </div>
    );
  }

  return (
    <div style={{ minHeight: '100vh', background: 'transparent', paddingBottom: 100, position: 'relative' }}>
      
      <div style={{ maxWidth: 700, margin: '0 auto', padding: 16, position: 'relative', zIndex: 10 }}>
        
        {/* Compact Profile Header */}
        <div style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.08)', borderRadius: 16, padding: 16, marginBottom: 16 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
            {/* Avatar */}
            <div style={{ position: 'relative', flexShrink: 0 }}>
              {isUploadingAvatar ? (
                <div style={{ width: 72, height: 72, borderRadius: '50%', background: 'rgba(139,92,246,0.2)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                  <div style={{ width: 24, height: 24, border: '3px solid rgba(139,92,246,0.3)', borderTop: '3px solid #a78bfa', borderRadius: '50%', animation: 'spin 1s linear infinite' }} />
                  <style>{`@keyframes spin { 0% { transform: rotate(0deg); } 100% { transform: rotate(360deg); } }`}</style>
                </div>
              ) : user?.avatar_base64 ? (
                <img src={user.avatar_base64} alt="" style={{ width: 72, height: 72, borderRadius: '50%', objectFit: 'cover', border: '2px solid rgba(139,92,246,0.3)' }} />
              ) : (
                <div style={{ width: 72, height: 72, borderRadius: '50%', background: DESIGN.colors.avatarGradient, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 28, fontWeight: 600, color: '#fff' }}>
                  {user?.username?.[0]?.toUpperCase()}
                </div>
              )}
              <button onClick={() => fileInputRef.current?.click()} disabled={isUploadingAvatar} style={{ position: 'absolute', bottom: -2, right: -2, width: 26, height: 26, borderRadius: '50%', background: DESIGN.colors.primaryGradient, border: '2px solid #0a0a15', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: isUploadingAvatar ? 'wait' : 'pointer' }}>
                <Camera size={12} color="#fff" />
              </button>
              <input ref={fileInputRef} type="file" accept="image/*" onChange={handleAvatarChange} style={{ display: 'none' }} />
            </div>
            
            {/* User Info */}
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
                <h2 style={{ fontSize: 18, fontWeight: 700, color: '#fff', margin: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{user?.display_name || user?.username}</h2>
                <UserRoleBadges user={user || {}} size="small" />
              </div>
              <p style={{ fontSize: 13, color: 'rgba(255,255,255,0.5)', margin: 0, marginBottom: 4, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{user?.email}</p>
              <p style={{ fontSize: 11, color: 'rgba(255,255,255,0.35)', margin: 0 }}>Member since {user?.created_at ? new Date(user.created_at).toLocaleDateString('en-US', { month: 'short', year: 'numeric' }) : 'Jan 2025'}</p>
            </div>
            
            {/* Action Icons */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              <button onClick={() => setShowEditModal(true)} style={{ width: 36, height: 36, borderRadius: 10, background: 'rgba(139,92,246,0.15)', border: '1px solid rgba(139,92,246,0.3)', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer' }}>
                <Edit size={16} color="#a78bfa" />
              </button>
              <button onClick={onLogout} style={{ width: 36, height: 36, borderRadius: 10, background: 'rgba(239,68,68,0.15)', border: '1px solid rgba(239,68,68,0.3)', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer' }}>
                <LogOut size={16} color="#ef4444" />
              </button>
            </div>
          </div>
        </div>

        {/* Progress Bars */}
        <div style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.08)', borderRadius: 16, padding: 16, marginBottom: 16 }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            {/* Train */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <span style={{ fontSize: 18, width: 24, textAlign: 'center' }}>🏋️</span>
              <span style={{ width: 60, fontSize: 13, color: 'rgba(255,255,255,0.6)', fontWeight: 500 }}>Train</span>
              <div style={{ flex: 1, height: 6, background: 'rgba(255,255,255,0.08)', borderRadius: 3, overflow: 'hidden' }}>
                <div style={{ height: '100%', width: `${Math.min((trickStats.mastered / 20) * 100, 100)}%`, background: 'linear-gradient(90deg, #22c55e, #4ade80)', borderRadius: 3 }} />
              </div>
              <div style={{ minWidth: 70, textAlign: 'right' }}>
                <span style={{ fontSize: 14, color: '#22c55e', fontWeight: 600 }}>{trickStats.mastered}</span>
                {trickStats.inProgress > 0 && <span style={{ fontSize: 11, color: '#fbbf24', marginLeft: 4 }}>+{trickStats.inProgress}</span>}
              </div>
            </div>
            
            {/* Learn */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <span style={{ fontSize: 18, width: 24, textAlign: 'center' }}>📚</span>
              <span style={{ width: 60, fontSize: 13, color: 'rgba(255,255,255,0.6)', fontWeight: 500 }}>Learn</span>
              <div style={{ flex: 1, height: 6, background: 'rgba(255,255,255,0.08)', borderRadius: 3, overflow: 'hidden' }}>
                <div style={{ height: '100%', width: `${Math.min((articleStats.read / 15) * 100, 100)}%`, background: DESIGN.colors.primaryGradient90, borderRadius: 3 }} />
              </div>
              <div style={{ minWidth: 70, textAlign: 'right' }}>
                <span style={{ fontSize: 14, color: '#a78bfa', fontWeight: 600 }}>{articleStats.read}</span>
                {articleStats.toRead > 0 && <span style={{ fontSize: 11, color: '#fbbf24', marginLeft: 4 }}>+{articleStats.toRead}</span>}
              </div>
            </div>
            
            {/* Calendar */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <span style={{ fontSize: 18, width: 24, textAlign: 'center' }}>📅</span>
              <span style={{ width: 60, fontSize: 13, color: 'rgba(255,255,255,0.6)', fontWeight: 500 }}>Calendar</span>
              <div style={{ flex: 1, height: 6, background: 'rgba(255,255,255,0.08)', borderRadius: 3, overflow: 'hidden' }}>
                <div style={{ height: '100%', width: `${Math.min(((eventsCount + userBookings.length) / 20) * 100, 100)}%`, background: 'linear-gradient(90deg, #3b82f6, #60a5fa)', borderRadius: 3 }} />
              </div>
              <div style={{ minWidth: 70, textAlign: 'right' }}>
                <span style={{ fontSize: 14, color: '#3b82f6', fontWeight: 600 }}>{eventsCount + userBookings.length}</span>
              </div>
            </div>
            
            {/* Badges */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <span style={{ fontSize: 18, width: 24, textAlign: 'center' }}>🎖️</span>
              <span style={{ width: 60, fontSize: 13, color: 'rgba(255,255,255,0.6)', fontWeight: 500 }}>Badges</span>
              <div style={{ flex: 1, height: 6, background: 'rgba(255,255,255,0.08)', borderRadius: 3, overflow: 'hidden' }}>
                <div style={{ height: '100%', width: `${Math.min((achievementsStats.earned / achievementsStats.total) * 100, 100)}%`, background: 'linear-gradient(90deg, #f59e0b, #fbbf24)', borderRadius: 3 }} />
              </div>
              <div style={{ minWidth: 70, textAlign: 'right' }}>
                <span style={{ fontSize: 14, color: '#fbbf24', fontWeight: 600 }}>{achievementsStats.earned}</span>
                <span style={{ fontSize: 11, color: 'rgba(255,255,255,0.4)' }}>/{achievementsStats.total}</span>
              </div>
            </div>
          </div>
          
          {/* Streak & Special */}
          {(achievementsStats.streak > 0 || achievementsStats.special > 0) && (
            <div style={{ marginTop: 14, paddingTop: 12, borderTop: '1px solid rgba(255,255,255,0.06)', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              {achievementsStats.streak > 0 ? (
                <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <span style={{ fontSize: 16 }}>🔥</span>
                  <span style={{ fontSize: 13, color: '#fbbf24', fontWeight: 600 }}>{achievementsStats.streak} day streak</span>
                </div>
              ) : <div />}
              {achievementsStats.special > 0 && (
                <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <span style={{ fontSize: 16 }}>⭐</span>
                  <span style={{ fontSize: 13, color: '#00CED1', fontWeight: 600 }}>{achievementsStats.special} Special</span>
                </div>
              )}
            </div>
          )}
        </div>

        {/* Achievements Section - Compact design with modal */}
        {(() => {
          // Calculate achievement totals
          let achTotalLikes = 0;
          let achTotalComments = 0;
          filteredAchievements.forEach(a => {
            const r = achievementReactions[a.id] || {};
            achTotalLikes += r.likesCount || 0;
            achTotalComments += r.commentsCount || 0;
          });
          const compactTierColors = { bronze: '#cd7f32', silver: '#c0c0c0', gold: '#ffd700' };
          
          return (
            <div style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.08)', borderRadius: 16, overflow: 'hidden', marginBottom: 16 }}>
              <button
                onClick={() => setExpandedAchievements(!expandedAchievements)}
                style={{
                  width: '100%',
                  display: 'flex',
                  alignItems: 'center',
                  gap: 10,
                  padding: 16,
                  background: 'none',
                  border: 'none',
                  cursor: 'pointer',
                  textAlign: 'left'
                }}
              >
                <Trophy size={20} color="#fbbf24" />
                <span style={{ flex: 1, fontSize: 15, fontWeight: 600, color: '#fff' }}>Achievements <span style={{ color: 'rgba(255,255,255,0.4)', fontWeight: 400 }}>({achievementsStats.earned}/{achievementsStats.total})</span></span>
                <span style={{ display: 'flex', alignItems: 'center', gap: 3, fontSize: 13, color: achTotalLikes > 0 ? '#ef4444' : 'rgba(255,255,255,0.3)' }}>
                  <Heart size={14} fill={achTotalLikes > 0 ? '#ef4444' : 'none'} color={achTotalLikes > 0 ? '#ef4444' : 'rgba(255,255,255,0.3)'} />{achTotalLikes}
                </span>
                <span style={{ display: 'flex', alignItems: 'center', gap: 3, fontSize: 13, color: achTotalComments > 0 ? '#3b82f6' : 'rgba(255,255,255,0.3)' }}>
                  <MessageCircle size={14} fill={achTotalComments > 0 ? '#3b82f6' : 'none'} color={achTotalComments > 0 ? '#3b82f6' : 'rgba(255,255,255,0.3)'} />{achTotalComments}
                </span>
                <ChevronDown size={18} color="rgba(255,255,255,0.4)" style={{ transform: expandedAchievements ? 'rotate(180deg)' : 'rotate(0)', transition: 'transform 0.2s' }} />
              </button>

              {expandedAchievements && (
                <div style={{ padding: '0 16px 16px' }}>
                  {/* Filter buttons */}
                  <div style={{ display: 'flex', gap: 6, marginBottom: 14 }}>
                    {[{ id: 'achieved', label: 'Achieved' }, { id: 'before_me', label: 'Before me' }].map(f => (
                      <button
                        key={f.id}
                        onClick={() => { haptic.light(); setAchievementsFilter(f.id); }}
                        style={{
                          padding: '6px 12px',
                          borderRadius: 14,
                          fontSize: 11,
                          fontWeight: 600,
                          border: 'none',
                          cursor: 'pointer',
                          background: achievementsFilter === f.id ? DESIGN.colors.primaryGradient : 'rgba(255,255,255,0.08)',
                          color: achievementsFilter === f.id ? '#fff' : 'rgba(255,255,255,0.5)'
                        }}
                      >
                        {f.label}
                      </button>
                    ))}
                  </div>

                  {/* Achievements - compact design */}
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                    {filteredAchievements.map(achievement => {
                      const reactions = achievementReactions[achievement.id] || { likesCount: 0, commentsCount: 0, userLiked: false, comments: [] };
                      const isCommentsExpanded = expandedTricks[`ach_${achievement.id}`];
                      const hasLikes = reactions.likesCount > 0;
                      const hasComments = reactions.commentsCount > 0;
                      const tc = compactTierColors[achievement.currentTier] || 'rgba(255,255,255,0.4)';
                      
                      return (
                        <div key={achievement.id} style={{ background: 'rgba(255,255,255,0.05)', borderRadius: 12, overflow: 'hidden' }}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '12px 14px' }}>
                            {/* Icon - clickable to open modal */}
                            <button
                              onClick={() => setSelectedAchievement(achievement)}
                              style={{ fontSize: 28, background: 'none', border: 'none', cursor: 'pointer', padding: 0 }}
                            >
                              {achievement.icon || '🏆'}
                            </button>
                            
                            {/* Name + Badge - clickable to open modal */}
                            <button
                              onClick={() => setSelectedAchievement(achievement)}
                              style={{ flex: 1, background: 'none', border: 'none', cursor: 'pointer', padding: 0, textAlign: 'left' }}
                            >
                              <div style={{ fontSize: 14, color: '#fff', fontWeight: 600, marginBottom: 4 }}>{achievement.name}</div>
                              {achievement.currentTier && (
                                <span style={{ fontSize: 10, padding: '3px 8px', borderRadius: 8, background: `${tc}20`, color: tc, fontWeight: 600, textTransform: 'uppercase' }}>
                                  {tierLabels[achievement.currentTier]}
                                </span>
                              )}
                            </button>
                            
                            {/* Like button */}
                            <button
                              onClick={(e) => { e.stopPropagation(); handleAchievementLike(achievement.id); }}
                              style={{
                                display: 'flex',
                                alignItems: 'center',
                                gap: 4,
                                padding: '8px 10px',
                                background: reactions.userLiked ? 'rgba(239,68,68,0.15)' : 'rgba(255,255,255,0.08)',
                                border: 'none',
                                borderRadius: 16,
                                cursor: 'pointer'
                              }}
                            >
                              <Heart size={16} color={hasLikes ? '#ef4444' : 'rgba(255,255,255,0.4)'} fill={hasLikes ? '#ef4444' : 'none'} />
                              <span style={{ fontSize: 12, color: hasLikes ? '#ef4444' : 'rgba(255,255,255,0.4)', fontWeight: 600 }}>{reactions.likesCount}</span>
                            </button>
                            
                            {/* Comment button - opens modal */}
                            <button
                              onClick={(e) => { 
                                e.stopPropagation(); 
                                openCommentModal('achievement', achievement.id, reactions.comments || []);
                              }}
                              style={{
                                display: 'flex',
                                alignItems: 'center',
                                gap: 4,
                                padding: '8px 10px',
                                background: hasComments ? 'rgba(59,130,246,0.15)' : 'rgba(255,255,255,0.08)',
                                border: 'none',
                                borderRadius: 16,
                                cursor: 'pointer'
                              }}
                            >
                              <MessageCircle size={16} color={hasComments ? '#3b82f6' : 'rgba(255,255,255,0.4)'} fill={hasComments ? '#3b82f6' : 'none'} />
                              <span style={{ fontSize: 12, color: hasComments ? '#3b82f6' : 'rgba(255,255,255,0.4)', fontWeight: 600 }}>{reactions.commentsCount}</span>
                            </button>
                          </div>
                        </div>
                      );
                    })}
                  </div>

                  {filteredAchievements.length === 0 && (
                    <div style={{ textAlign: 'center', padding: 32, color: 'rgba(255,255,255,0.5)' }}>
                      <Award size={40} style={{ opacity: 0.3, marginBottom: 12 }} />
                      <p style={{ margin: 0, fontSize: 13 }}>No achievements {achievementsFilter === 'achieved' ? 'earned yet' : 'waiting for you'}</p>
                    </div>
                  )}
                </div>
              )}
            </div>
          );
        })()}

        {/* Mastered Tricks Section - Same design as Achievements */}
        {trickStats.mastered > 0 && (() => {
          const categoryOrder = CATEGORY_ORDER;
          const categoryNames = Object.fromEntries(Object.entries(TRICK_CATEGORIES).map(([k, v]) => [k, v.label]));
          const categoryIcons = Object.fromEntries(Object.entries(TRICK_CATEGORIES).map(([k, v]) => [k, v.icon]));
          
          // Get mastered tricks with full data from tricks prop
          const masteredTricks = tricks.filter(t => userTricks[t.id]?.status === 'mastered').map(t => ({ ...t, trick_id: t.id }));
          
          // Group by category
          const tricksByCategory = masteredTricks.reduce((acc, t) => {
            const cat = t.category || 'other';
            if (!acc[cat]) acc[cat] = [];
            acc[cat].push(t);
            return acc;
          }, {});
          
          // Calculate totals for all mastered tricks
          let allTricksLikes = 0;
          let allTricksComments = 0;
          masteredTricks.forEach(t => {
            const r = trickReactions[t.trick_id] || {};
            allTricksLikes += r.likesCount || 0;
            allTricksComments += r.commentsCount || 0;
          });
          
          const getCategoryTotals = (categoryTricks) => {
            let totalLikes = 0;
            let totalComments = 0;
            categoryTricks.forEach(t => {
              const r = trickReactions[t.trick_id] || {};
              totalLikes += r.likesCount || 0;
              totalComments += r.commentsCount || 0;
            });
            return { totalLikes, totalComments };
          };
          
          const toggleCategory = (cat) => {
            setExpandedCategories(prev => ({ ...prev, [cat]: !prev[cat] }));
          };
          
          return (
            <div style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.08)', borderRadius: 16, overflow: 'hidden', marginBottom: 16 }}>
              <button
                onClick={() => setExpandedMasteredTricks(!expandedMasteredTricks)}
                style={{
                  width: '100%',
                  display: 'flex',
                  alignItems: 'center',
                  gap: 10,
                  padding: 16,
                  background: 'none',
                  border: 'none',
                  cursor: 'pointer',
                  textAlign: 'left'
                }}
              >
                <Award size={20} color="#a78bfa" />
                <span style={{ flex: 1, fontSize: 15, fontWeight: 600, color: '#fff' }}>Mastered Tricks <span style={{ color: 'rgba(255,255,255,0.4)', fontWeight: 400 }}>({masteredTricks.length})</span></span>
                <span style={{ display: 'flex', alignItems: 'center', gap: 3, fontSize: 13, color: allTricksLikes > 0 ? '#ef4444' : 'rgba(255,255,255,0.3)' }}>
                  <Heart size={14} fill={allTricksLikes > 0 ? '#ef4444' : 'none'} color={allTricksLikes > 0 ? '#ef4444' : 'rgba(255,255,255,0.3)'} />{allTricksLikes}
                </span>
                <span style={{ display: 'flex', alignItems: 'center', gap: 3, fontSize: 13, color: allTricksComments > 0 ? '#3b82f6' : 'rgba(255,255,255,0.3)' }}>
                  <MessageCircle size={14} fill={allTricksComments > 0 ? '#3b82f6' : 'none'} color={allTricksComments > 0 ? '#3b82f6' : 'rgba(255,255,255,0.3)'} />{allTricksComments}
                </span>
                <ChevronDown size={18} color="rgba(255,255,255,0.4)" style={{ transform: expandedMasteredTricks ? 'rotate(180deg)' : 'rotate(0)', transition: 'transform 0.2s' }} />
              </button>

              {expandedMasteredTricks && (
                <div style={{ padding: '0 16px 16px' }}>
                  {/* Categories */}
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                    {categoryOrder.filter(cat => tricksByCategory[cat]?.length > 0).map(cat => {
                      const catTricks = tricksByCategory[cat] || [];
                      const isExpanded = expandedCategories[cat];
                      const { totalLikes, totalComments } = getCategoryTotals(catTricks);
                      
                      return (
                        <div key={cat} style={{ background: 'rgba(255,255,255,0.03)', borderRadius: 12, overflow: 'hidden' }}>
                          <button
                            onClick={() => toggleCategory(cat)}
                            style={{ width: '100%', display: 'flex', alignItems: 'center', gap: 10, padding: '12px 14px', background: 'none', border: 'none', cursor: 'pointer', textAlign: 'left' }}
                          >
                            <span style={{ fontSize: 20 }}>{categoryIcons[cat]}</span>
                            <span style={{ flex: 1, fontSize: 14, fontWeight: 600, color: '#fff' }}>{categoryNames[cat]} <span style={{ color: 'rgba(255,255,255,0.4)', fontWeight: 400 }}>({catTricks.length})</span></span>
                            <span style={{ display: 'flex', alignItems: 'center', gap: 3, fontSize: 13, color: totalLikes > 0 ? '#ef4444' : 'rgba(255,255,255,0.3)' }}>
                              <Heart size={14} fill={totalLikes > 0 ? '#ef4444' : 'none'} color={totalLikes > 0 ? '#ef4444' : 'rgba(255,255,255,0.3)'} />{totalLikes}
                            </span>
                            <span style={{ display: 'flex', alignItems: 'center', gap: 3, fontSize: 13, color: totalComments > 0 ? '#3b82f6' : 'rgba(255,255,255,0.3)' }}>
                              <MessageCircle size={14} fill={totalComments > 0 ? '#3b82f6' : 'none'} color={totalComments > 0 ? '#3b82f6' : 'rgba(255,255,255,0.3)'} />{totalComments}
                            </span>
                            <ChevronDown size={18} color="rgba(255,255,255,0.4)" style={{ transform: isExpanded ? 'rotate(180deg)' : 'rotate(0)', transition: 'transform 0.2s' }} />
                          </button>
                          
                          {isExpanded && (
                            <div style={{ padding: '0 14px 12px', display: 'flex', flexDirection: 'column', gap: 8 }}>
                              {catTricks.map(trick => {
                                const reactions = trickReactions[trick.trick_id] || { likesCount: 0, commentsCount: 0, userLiked: false, comments: [] };
                                const hasLikes = reactions.likesCount > 0;
                                const hasComments = reactions.commentsCount > 0;
                                
                                return (
                                  <div key={trick.id} style={{ background: 'rgba(255,255,255,0.05)', borderRadius: 10, overflow: 'hidden' }}>
                                    <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '12px 14px' }}>
                                      <span style={{ flex: 1, fontSize: 14, color: '#fff', fontWeight: 500 }}>{trick.name}</span>
                                      <button onClick={() => handleLike(trick.trick_id)} style={{ display: 'flex', alignItems: 'center', gap: 4, padding: '8px 10px', background: reactions.userLiked ? 'rgba(239,68,68,0.15)' : 'rgba(255,255,255,0.08)', border: 'none', borderRadius: 16, cursor: 'pointer' }}>
                                        <Heart size={16} color={hasLikes ? '#ef4444' : 'rgba(255,255,255,0.4)'} fill={hasLikes ? '#ef4444' : 'none'} />
                                        <span style={{ fontSize: 12, color: hasLikes ? '#ef4444' : 'rgba(255,255,255,0.4)', fontWeight: 600 }}>{reactions.likesCount}</span>
                                      </button>
                                      <button onClick={() => openCommentModal('trick', trick.trick_id, reactions.comments || [])} style={{ display: 'flex', alignItems: 'center', gap: 4, padding: '8px 10px', background: hasComments ? 'rgba(59,130,246,0.15)' : 'rgba(255,255,255,0.08)', border: 'none', borderRadius: 16, cursor: 'pointer' }}>
                                        <MessageCircle size={16} color={hasComments ? '#3b82f6' : 'rgba(255,255,255,0.4)'} fill={hasComments ? '#3b82f6' : 'none'} />
                                        <span style={{ fontSize: 12, color: hasComments ? '#3b82f6' : 'rgba(255,255,255,0.4)', fontWeight: 600 }}>{reactions.commentsCount}</span>
                                      </button>
                                    </div>
                                  </div>
                                );
                              })}
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}
            </div>
          );
        })()}

        {/* History Section - Activity Feed */}
        {myFeed.length > 0 && (() => {
          const activityIcon = (type) => {
            switch(type) {
              case 'trick_mastered': return '🏆';
              case 'trick_started': return '🏋️';
              case 'achievement_earned': return '🎖️';
              case 'event_joined': return '🎉';
              default: return '📌';
            }
          };
          const activityVerb = (type) => {
            switch(type) {
              case 'trick_mastered': return 'mastered';
              case 'trick_started': return 'started';
              case 'achievement_earned': return 'earned';
              case 'event_joined': return 'joined';
              default: return '';
            }
          };
          const activityColor = (type) => {
            switch(type) {
              case 'trick_mastered': return '#22c55e';
              case 'trick_started': return '#8b5cf6';
              case 'achievement_earned': return '#fbbf24';
              case 'event_joined': return '#3b82f6';
              default: return 'rgba(255,255,255,0.5)';
            }
          };
          const activityName = (item) => {
            if (item.data?.trick_name) return item.data.trick_name;
            if (item.data?.achievement_name) return `${item.data.achievement_name}${item.data.tier ? ` (${item.data.tier})` : ''}`;
            if (item.data?.event_title) return item.data.event_title;
            return '';
          };
          return (
            <div style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.08)', borderRadius: 16, overflow: 'hidden', marginTop: 16 }}>
              <button
                onClick={() => setExpandedHistory(!expandedHistory)}
                style={{ width: '100%', display: 'flex', alignItems: 'center', gap: 10, padding: 16, background: 'none', border: 'none', cursor: 'pointer', textAlign: 'left' }}
              >
                <Clock size={20} color="#60a5fa" />
                <span style={{ flex: 1, fontSize: 15, fontWeight: 600, color: '#fff' }}>History <span style={{ color: 'rgba(255,255,255,0.4)', fontWeight: 400 }}>({myFeed.length})</span></span>
                <ChevronDown size={18} color="rgba(255,255,255,0.4)" style={{ transform: expandedHistory ? 'rotate(180deg)' : 'rotate(0)', transition: 'transform 0.2s' }} />
              </button>
              {expandedHistory && (
                <div style={{ padding: '0 16px 16px', display: 'flex', flexDirection: 'column', gap: 6 }}>
                  {myFeed.map((item, idx) => {
                    const color = activityColor(item.type);
                    return (
                      <div key={item.id || idx} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 12px', background: 'rgba(255,255,255,0.03)', borderRadius: 10 }}>
                        <span style={{ fontSize: 20, width: 28, textAlign: 'center', flexShrink: 0 }}>{activityIcon(item.type)}</span>
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div style={{ fontSize: 13, color: '#fff', lineHeight: 1.4 }}>
                            <span style={{ color: 'rgba(255,255,255,0.5)' }}>{activityVerb(item.type)} </span>
                            <span style={{ fontWeight: 600, color }}>{activityName(item)}</span>
                          </div>
                          <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.3)', marginTop: 2 }}>
                            {item.created_at ? getTimeAgo(new Date(item.created_at)) : ''}
                          </div>
                        </div>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
                          {(item.reactions_count > 0 || item.comments_count > 0) && (
                            <>
                              {item.reactions_count > 0 && (
                                <span style={{ display: 'flex', alignItems: 'center', gap: 3, fontSize: 12, color: '#ef4444' }}>
                                  <Heart size={12} color="#ef4444" fill="#ef4444" />{item.reactions_count}
                                </span>
                              )}
                              {item.comments_count > 0 && (
                                <span style={{ display: 'flex', alignItems: 'center', gap: 3, fontSize: 12, color: '#3b82f6' }}>
                                  <MessageCircle size={12} color="#3b82f6" fill="#3b82f6" />{item.comments_count}
                                </span>
                              )}
                            </>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          );
        })()}

        {/* Edit Modal */}
        {showEditModal && (
          <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.8)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 100, padding: 16 }}>
            <div style={{ background: '#0a0a1a', border: '1px solid rgba(255,255,255,0.1)', borderRadius: DESIGN.radius.xxl, padding: 24, width: '100%', maxWidth: 400 }}>
              <h2 style={{ fontSize: 20, fontWeight: 700, color: '#fff', marginBottom: 20 }}>Edit Profile</h2>
              
              <div style={{ marginBottom: 16 }}>
                <label style={{ display: 'block', fontSize: 13, color: 'rgba(255,255,255,0.6)', marginBottom: 8 }}>Email</label>
                <input type="email" value={editEmail} onChange={e => setEditEmail(e.target.value)} style={{ width: '100%', padding: '12px 16px', background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.1)', borderRadius: 12, color: '#fff', fontSize: 14, outline: 'none', boxSizing: 'border-box' }} />
              </div>

              <div style={{ marginBottom: 16 }}>
                <label style={{ display: 'block', fontSize: 13, color: 'rgba(255,255,255,0.6)', marginBottom: 8 }}>New Password (leave empty to keep current)</label>
                <input type="password" value={editPassword} onChange={e => setEditPassword(e.target.value)} placeholder="••••••••" style={{ width: '100%', padding: '12px 16px', background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.1)', borderRadius: 12, color: '#fff', fontSize: 14, outline: 'none', boxSizing: 'border-box' }} />
              </div>

              <div style={{ marginBottom: 24 }}>
                <label style={{ display: 'block', fontSize: 13, color: 'rgba(255,255,255,0.6)', marginBottom: 8 }}>Confirm New Password</label>
                <input type="password" value={editConfirmPassword} onChange={e => setEditConfirmPassword(e.target.value)} placeholder="••••••••" style={{ width: '100%', padding: '12px 16px', background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.1)', borderRadius: 12, color: '#fff', fontSize: 14, outline: 'none', boxSizing: 'border-box' }} />
              </div>

              <div style={{ display: 'flex', gap: 12 }}>
                <button onClick={() => setShowEditModal(false)} style={{ flex: 1, padding: 14, background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.1)', borderRadius: 12, color: '#fff', fontSize: 14, fontWeight: 600, cursor: 'pointer' }}>Cancel</button>
                <button onClick={handleSaveProfile} style={{ flex: 1, padding: 14, background: DESIGN.colors.primaryGradient, border: 'none', borderRadius: 12, color: '#fff', fontSize: 14, fontWeight: 600, cursor: 'pointer' }}>Save</button>
              </div>
            </div>
          </div>
        )}
        
        {/* Comments Modal */}
        {(() => {
          
          
          return (
            <CommentsModal
              isOpen={commentModal.isOpen}
              onClose={closeCommentModal}
              comments={commentModal.comments}
              isLoading={commentModal.isLoading}
              onAddComment={(content) => {
                if (commentModal.type === 'achievement') {
                  handleAddAchievementComment(commentModal.id, content);
                } else if (commentModal.type === 'trick') {
                  handleAddTrickComment(commentModal.id, content);
                }
              }}
              onLikeComment={(commentId) => {
                if (commentModal.type === 'achievement') {
                  handleAchievementCommentLike(commentModal.id, commentId);
                } else if (commentModal.type === 'trick') {
                  handleCommentLike(commentModal.id, commentId);
                }
              }}
              onDeleteComment={(commentId) => {
                if (commentModal.type === 'achievement') {
                  handleDeleteAchievementComment(commentModal.id, commentId);
                } else if (commentModal.type === 'trick') {
                  handleDeleteComment(commentModal.id, commentId);
                }
              }}
              onNavigateToUser={navigateToUserProfile}
              currentUserId={user?.id}
            />
          );
        })()}
      </div>
    </div>
  );
};


// Exports


