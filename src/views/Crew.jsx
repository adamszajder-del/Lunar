// src/views/Crew.jsx
import { useState, useEffect, useRef, useCallback } from 'react';
import { DESIGN, TRICK_CATEGORIES, CATEGORY_ORDER } from '../config';
import { api } from '../api';
import { haptic } from '../utils/haptic';
import { showToast } from '../utils/toast';
import { useAuth } from '../hooks/useAuth';
import { useSwipeBack } from '../hooks/useSwipeBack';
import { getTimeAgo } from '../utils/time';
import { Heart, Trophy, Star, Award, Send, Search, ChevronLeft, ChevronDown, ChevronRight, X, Trash, MessageCircle, Check, Users, TrendingUp, Plus, Globe, Clock } from '../components/icons';
import { CrewMemberSkeleton } from '../components/Skeletons';
import { TIER_COLORS, TIER_LABELS } from '../constants/tiers';
import { UserRoleBadges, RoleBadge, Badge } from '../components/ui/Badge';
import { EmptyStateIllustration } from '../components/ui/EmptyState';
import { CommentsModal } from '../components/CommentsModal';
import { AchievementCard } from '../components/Cards';

// Use React hooks from window (declared in core.js)

export const FriendsView = ({ appLoading, crew, friends, friendRequests, onAcceptRequest, onDeclineRequest, onSendRequest, favorites, onToggleFavorite, initialSelectedMember, onClearSelectedMember, onSelectMember, onNavigateToTrick }) => {
  const { user } = useAuth();
  const [selectedMember, setSelectedMember] = useState(initialSelectedMember || null);
  const [memberAchievements, setMemberAchievements] = useState([]);
  const [memberStats, setMemberStats] = useState(null);
  const [memberTricks, setMemberTricks] = useState([]);
  const [trickReactions, setTrickReactions] = useState({});
  const [achievementReactions, setAchievementReactions] = useState({});
  const [expandedCategories, setExpandedCategories] = useState({});
  const [expandedTricks, setExpandedTricks] = useState({});
  const [expandedMasteredTricks, setExpandedMasteredTricks] = useState(false);
  const [expandedAchievements, setExpandedAchievements] = useState(false);
  const [expandedHistory, setExpandedHistory] = useState(false);
  const [memberFeed, setMemberFeed] = useState([]);
  const [selectedAchievementForModal, setSelectedAchievementForModal] = useState(null);
  const [newComment, setNewComment] = useState('');
  const [commentingOn, setCommentingOn] = useState(null);
  const [showSearch, setShowSearch] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [filter, setFilter] = useState('friends'); // 'friends', 'followers', or 'add'
  const [followers, setFollowers] = useState([]);
  
  // Comment modal state (Instagram-style)
  const [commentModal, setCommentModal] = useState({ isOpen: false, type: null, id: null, comments: [], isLoading: false });

  // Fetch followers on mount
  useEffect(() => {
    const fetchFollowers = async () => {
      try {
        const res = await api.get('/api/users/me/followers');
        if (res?.followers) {
          setFollowers(res.followers.map(f => f.id));
        }
      } catch (e) {
        // silent;
      }
    };
    fetchFollowers();
  }, []);

  // Swipe back gesture for member detail
  useSwipeBack(() => {
    if (selectedMember) {
      setSelectedMember(null);
      if (onClearSelectedMember) onClearSelectedMember();
    }
  }, !!selectedMember);

  // Handle initial selected member from external navigation (e.g. deep link)
  useEffect(() => {
    if (initialSelectedMember && !selectedMember) {
      setSelectedMember(initialSelectedMember);
    }
  }, [initialSelectedMember]);

  // Fetch member achievements, stats and tricks when selected
  useEffect(() => {
    const fetchMemberData = async () => {
      if (!selectedMember) {
        setMemberAchievements([]);
        setMemberStats(null);
        setMemberTricks([]);
        setMemberFeed([]);
        setTrickReactions({});
        setAchievementReactions({});
        setExpandedCategories({});
        setExpandedTricks({});
        setExpandedAchievements(false);
        setExpandedHistory(false);
        setCommentingOn(null);
        setNewComment('');
        return;
      }
      try {
        const [achievementsRes, statsRes, tricksRes] = await Promise.all([
          api.get(`/api/users/${selectedMember.id}/achievements`),
          api.get(`/api/users/${selectedMember.id}/stats`),
          api.get(`/api/users/${selectedMember.id}/tricks`)
        ]);
        if (achievementsRes) setMemberAchievements(achievementsRes);
        if (statsRes) setMemberStats(statsRes);
        
        const masteredTricks = tricksRes ? tricksRes.filter(t => t.status === 'mastered') : [];
        setMemberTricks(masteredTricks);
        
        // Fetch trick reactions
        if (masteredTricks.length > 0) {
          try {
            const reactionsRes = await api.get(`/api/users/${selectedMember.id}/tricks/reactions`);
            if (reactionsRes) {
              const reactionsMap = {};
              reactionsRes.forEach(r => {
                reactionsMap[r.trick_id] = {
                  comments: r.comments || [],
                  likesCount: r.likes_count || 0,
                  commentsCount: r.comments_count || 0,
                  userLiked: r.user_liked || false
                };
              });
              setTrickReactions(reactionsMap);
            }
          } catch (e) {
            // silent;
          }
        }
        
        // Fetch achievement reactions
        try {
          const achReactionsRes = await api.get(`/api/users/${selectedMember.id}/achievements/reactions`);
          if (achReactionsRes) {
            const achReactionsMap = {};
            achReactionsRes.forEach(r => {
              achReactionsMap[r.achievement_id] = {
                comments: r.comments || [],
                likesCount: r.likes_count || 0,
                commentsCount: r.comments_count || 0,
                userLiked: r.user_liked || false
              };
            });
            setAchievementReactions(achReactionsMap);
          }
        } catch (e) {
          // silent;
        }
        
        // Fetch member activity feed (History)
        try {
          const feedRes = await api.get(`/api/users/${selectedMember.id}/activity`);
          if (feedRes?.items) {
            setMemberFeed(feedRes.items);
          }
        } catch (e) {
          // silent - endpoint may not exist yet;
        }
      } catch (err) {
        console.error('Failed to fetch member data:', err);
      }
    };
    fetchMemberData();
  }, [selectedMember]);

  // State for leaderboard modal
  const [showLeaderboard, setShowLeaderboard] = useState(false);
  const [leaderboardFilter, setLeaderboardFilter] = useState('friends'); // 'friends' or 'world'
  
  // State for search in Add tab
  const [addSearchQuery, setAddSearchQuery] = useState('');

  // Use only crew to avoid duplicates (crew already contains all users)
  // Filter out current user - don't show yourself in the list
  const allMembers = crew.filter(m => m.id !== user?.id);
  
  // Users not yet followed (for Add tab)
  const notFollowedMembers = allMembers.filter(m => !favorites.users?.includes(m.id));
  
  // Sort favorites to top, then filter by selection
  const sortedMembers = [...allMembers]
    .filter(m => {
      if (filter === 'add') {
        // Show only not followed, apply search if present
        const notFollowed = !favorites.users?.includes(m.id);
        if (!notFollowed) return false;
        if (addSearchQuery) {
          const query = addSearchQuery.toLowerCase();
          return m.username?.toLowerCase().includes(query) || m.display_name?.toLowerCase().includes(query);
        }
        return true;
      }
      if (filter === 'friends') return favorites.users?.includes(m.id);
      if (filter === 'fans') return followers.includes(m.id);
      return true;
    })
    .sort((a, b) => {
      const aFav = favorites.users?.includes(a.id);
      const bFav = favorites.users?.includes(b.id);
      if (aFav && !bFav) return -1;
      if (!aFav && bFav) return 1;
      return 0;
    });
  
  const searchResults = searchQuery ? allMembers.filter(m => m.username?.toLowerCase().includes(searchQuery.toLowerCase()) || m.display_name?.toLowerCase().includes(searchQuery.toLowerCase())) : [];

  const handleStarClick = (e, memberId) => {
    e.stopPropagation();
    onToggleFavorite && onToggleFavorite('user', memberId);
  };

  if (selectedMember) {
    const isFavorite = favorites.users?.includes(selectedMember.id);
    const stats = memberStats || { tricks: { mastered: selectedMember.mastered || 0, inProgress: selectedMember.in_progress || 0 }, articles: { read: selectedMember.articles_read || 0, toRead: selectedMember.articles_to_read || 0 }, events: 0, bookings: 0 };
    
    // Filter achievements - show only those with progress > 0
    const filteredMemberAchievements = memberAchievements.filter(a => (a.progress || 0) > 0);
    
    // Group mastered tricks by category
    const tricksByCategory = memberTricks.reduce((acc, t) => {
      const cat = t.category || 'other';
      if (!acc[cat]) acc[cat] = [];
      acc[cat].push(t);
      return acc;
    }, {});
    
    const categoryOrder = CATEGORY_ORDER;
    const categoryNames = Object.fromEntries(Object.entries(TRICK_CATEGORIES).map(([k, v]) => [k, v.label]));
    const categoryIcons = Object.fromEntries(Object.entries(TRICK_CATEGORIES).map(([k, v]) => [k, v.icon]));
    
    const toggleCategory = (cat) => {
      setExpandedCategories(prev => ({ ...prev, [cat]: !prev[cat] }));
    };
    
    const toggleTrickComments = (trickId) => {
      setExpandedTricks(prev => ({ ...prev, [trickId]: !prev[trickId] }));
    };
    
    // Calculate category totals (likes + comments)
    const getCategoryTotals = (tricks) => {
      let totalLikes = 0;
      let totalComments = 0;
      tricks.forEach(t => {
        const r = trickReactions[t.trick_id] || {};
        totalLikes += r.likesCount || 0;
        totalComments += r.commentsCount || 0;
      });
      return { totalLikes, totalComments };
    };
    
    const handleLike = async (trickId) => {
      if (!user) return;
      try {
        const res = await api.post(`/api/users/${selectedMember.id}/tricks/${trickId}/like`);
        if (res) {
          setTrickReactions(prev => ({
            ...prev,
            [trickId]: {
              ...prev[trickId],
              likesCount: res.likes_count,
              userLiked: res.user_liked
            }
          }));
          haptic.light();
        }
      } catch (err) {
        console.error('Failed to toggle like:', err);
      }
    };
    
    const handleCommentLike = async (trickId, commentId) => {
      if (!user) return;
      try {
        const res = await api.post(`/api/users/${selectedMember.id}/tricks/${trickId}/comments/${commentId}/like`);
        if (res) {
          const updateComments = (comments) => comments?.map(c => 
            c.id === commentId ? { ...c, likes_count: res.likes_count, user_liked: res.user_liked } : c
          ) || [];
          
          setTrickReactions(prev => ({
            ...prev,
            [trickId]: {
              ...prev[trickId],
              comments: updateComments(prev[trickId]?.comments)
            }
          }));
          
          // Update modal if open
          if (commentModal.isOpen && commentModal.type === 'trick' && commentModal.id === trickId) {
            setCommentModal(prev => ({ ...prev, comments: updateComments(prev.comments) }));
          }
          
          haptic.light();
        }
      } catch (err) {
        console.error('Failed to toggle comment like:', err);
      }
    };
    
    const handleDeleteComment = async (trickId, commentId) => {
      if (!user) return;
      try {
        await api.delete(`/api/users/${selectedMember.id}/tricks/${trickId}/comments/${commentId}`);
        
        const filterComments = (comments) => comments?.filter(c => c.id !== commentId) || [];
        
        setTrickReactions(prev => ({
          ...prev,
          [trickId]: {
            ...prev[trickId],
            comments: filterComments(prev[trickId]?.comments),
            commentsCount: Math.max(0, (prev[trickId]?.commentsCount || 1) - 1)
          }
        }));
        
        // Update modal if open
        if (commentModal.isOpen && commentModal.type === 'trick' && commentModal.id === trickId) {
          setCommentModal(prev => ({ ...prev, comments: filterComments(prev.comments) }));
        }
        
        showToast('Comment deleted');
        haptic.light();
      } catch (err) {
        console.error('Failed to delete comment:', err);
        showToast('Failed to delete comment', 'error');
      }
    };
    
    const handleAddComment = async (trickId, content) => {
      const commentContent = content || newComment.trim();
      if (!user || !commentContent) return;
      try {
        const res = await api.post(`/api/users/${selectedMember.id}/tricks/${trickId}/comment`, {
          content: commentContent
        });
        if (res) {
          setTrickReactions(prev => ({
            ...prev,
            [trickId]: {
              ...prev[trickId],
              comments: [...(prev[trickId]?.comments || []), res],
              commentsCount: (prev[trickId]?.commentsCount || 0) + 1
            }
          }));
          
          // Update modal if open
          if (commentModal.isOpen && commentModal.type === 'trick' && commentModal.id === trickId) {
            setCommentModal(prev => ({ ...prev, comments: [...prev.comments, res] }));
          }
          
          setNewComment('');
          setCommentingOn(null);
          showToast('Comment added!');
          haptic.success();
        }
      } catch (err) {
        console.error('Failed to add comment:', err);
        showToast('Failed to add comment', 'error');
      }
    };
    
    // Achievement handlers
    const handleAchievementLike = async (achievementId) => {
      if (!user) return;
      try {
        const res = await api.post(`/api/users/${selectedMember.id}/achievements/${achievementId}/like`);
        if (res) {
          setAchievementReactions(prev => ({
            ...prev,
            [achievementId]: {
              ...prev[achievementId],
              likesCount: res.likes_count,
              userLiked: res.user_liked
            }
          }));
          haptic.light();
        }
      } catch (err) {
        console.error('Failed to toggle achievement like:', err);
      }
    };
    
    // Open comment modal (Instagram-style)
    const openCommentModal = (type, id, comments = []) => {
      setCommentModal({ isOpen: true, type, id, comments, isLoading: false });
    };
    
    const closeCommentModal = () => {
      setCommentModal({ isOpen: false, type: null, id: null, comments: [], isLoading: false });
    };
    
    const handleAchievementCommentLike = async (achievementId, commentId) => {
      if (!user) return;
      try {
        const res = await api.post(`/api/users/${selectedMember.id}/achievements/${achievementId}/comments/${commentId}/like`);
        if (res) {
          // Update both achievementReactions and commentModal
          const updateComments = (comments) => comments?.map(c => 
            c.id === commentId ? { ...c, likes_count: res.likes_count, user_liked: res.user_liked } : c
          ) || [];
          
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
      } catch (err) {
        console.error('Failed to toggle achievement comment like:', err);
      }
    };
    
    const handleDeleteAchievementComment = async (achievementId, commentId) => {
      if (!user) return;
      try {
        await api.delete(`/api/users/${selectedMember.id}/achievements/${achievementId}/comments/${commentId}`);
        
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
      } catch (err) {
        console.error('Failed to delete comment:', err);
      }
    };
    
    const handleAddAchievementComment = async (achievementId, content) => {
      const commentContent = content || newComment.trim();
      if (!user || !commentContent) return;
      try {
        const res = await api.post(`/api/users/${selectedMember.id}/achievements/${achievementId}/comment`, {
          content: commentContent
        });
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
      } catch (err) {
        console.error('Failed to add comment:', err);
      }
    };
    
    const navigateToUserProfile = (userId) => {
      const member = crew.find(m => m.id === userId);
      if (member) {
        setSelectedMember(member);
        haptic.light();
      }
    };
    
    const handleBack = () => {
      haptic.light();
      setSelectedMember(null);
      if (onClearSelectedMember) onClearSelectedMember();
      window.history.pushState(null, '', '#crew');
    };
    
    return (
      <div style={{ minHeight: '100vh', background: 'transparent', paddingBottom: 100, position: 'relative' }}>
        
        {/* Sticky Top Bar with Back Button */}
        <div style={{ position: 'sticky', top: 0, zIndex: 40, background: 'rgba(5,5,15,0.9)', backdropFilter: 'blur(20px)', borderBottom: '1px solid rgba(255,255,255,0.1)' }}>
          <div style={{ maxWidth: 700, margin: '0 auto', padding: '12px 16px' }}>
            <button onClick={handleBack} className="btn-press tap-highlight" style={{ display: 'flex', alignItems: 'center', gap: 8, background: 'none', border: 'none', color: 'rgba(255,255,255,0.7)', fontSize: 14, fontWeight: 500, cursor: 'pointer', padding: 0 }}>
              <ChevronLeft size={20} /> Back
            </button>
          </div>
        </div>
        
        <div style={{ maxWidth: 700, margin: '0 auto', padding: 16, position: 'relative', zIndex: 10 }}>
          
          {/* Profile Header - Avatar left, info centered right */}
          <div style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.08)', borderRadius: 16, padding: 16, marginBottom: 16, position: 'relative' }}>
            {/* Favorite Button - Top Right Corner */}
            <button onClick={(e) => handleStarClick(e, selectedMember.id)} style={{ position: 'absolute', top: 12, right: 12, width: 40, height: 40, borderRadius: 12, background: isFavorite ? 'rgba(251,191,36,0.15)' : 'rgba(255,255,255,0.08)', border: `1px solid ${isFavorite ? 'rgba(251,191,36,0.3)' : 'rgba(255,255,255,0.1)'}`, display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer' }}>
              <Star size={18} color={isFavorite ? '#fbbf24' : 'rgba(255,255,255,0.4)'} filled={isFavorite} />
            </button>
            
            <div style={{ display: 'flex', alignItems: 'center', gap: 16, minHeight: 72 }}>
              {/* Avatar - Left */}
              {selectedMember.avatar_base64 ? (
                <img src={selectedMember.avatar_base64} alt="" style={{ width: 72, height: 72, borderRadius: '50%', objectFit: 'cover', border: '2px solid rgba(139,92,246,0.3)', flexShrink: 0 }} />
              ) : (
                <div style={{ width: 72, height: 72, borderRadius: '50%', background: DESIGN.colors.avatarGradient, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 28, fontWeight: 600, color: '#fff', flexShrink: 0 }}>
                  {selectedMember.username?.[0]?.toUpperCase()}
                </div>
              )}
              
              {/* Info - Centered vertically and horizontally */}
              <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', textAlign: 'center', paddingRight: 40 }}>
                <h2 style={{ fontSize: 18, fontWeight: 700, color: '#fff', margin: '0 0 6px 0' }}>{selectedMember.display_name || selectedMember.username}</h2>
                <div style={{ marginBottom: 6 }}>
                  <UserRoleBadges user={selectedMember} size="small" />
                </div>
                {selectedMember.created_at && (
                  <p style={{ fontSize: 11, color: 'rgba(255,255,255,0.35)', margin: 0 }}>Member since {new Date(selectedMember.created_at).toLocaleDateString('en-US', { month: 'short', year: 'numeric' })}</p>
                )}
              </div>
            </div>
          </div>

          {/* Progress Bars - only for non-coaches */}
          {!selectedMember.is_coach && (
            <div style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.08)', borderRadius: 16, padding: 16, marginBottom: 16 }}>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
                {/* Train */}
                <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                  <span style={{ fontSize: 18, width: 24, textAlign: 'center' }}>🏋️</span>
                  <span style={{ width: 60, fontSize: 13, color: 'rgba(255,255,255,0.6)', fontWeight: 500 }}>Train</span>
                  <div style={{ flex: 1, height: 6, background: 'rgba(255,255,255,0.08)', borderRadius: 3, overflow: 'hidden' }}>
                    <div style={{ height: '100%', width: `${Math.min(((stats.tricks?.mastered || 0) / 20) * 100, 100)}%`, background: 'linear-gradient(90deg, #22c55e, #4ade80)', borderRadius: 3 }} />
                  </div>
                  <div style={{ minWidth: 70, textAlign: 'right' }}>
                    <span style={{ fontSize: 14, color: '#22c55e', fontWeight: 600 }}>{stats.tricks?.mastered || 0}</span>
                    {(stats.tricks?.inProgress || 0) > 0 && <span style={{ fontSize: 11, color: '#fbbf24', marginLeft: 4 }}>+{stats.tricks?.inProgress || 0}</span>}
                  </div>
                </div>
                
                {/* Learn */}
                <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                  <span style={{ fontSize: 18, width: 24, textAlign: 'center' }}>📚</span>
                  <span style={{ width: 60, fontSize: 13, color: 'rgba(255,255,255,0.6)', fontWeight: 500 }}>Learn</span>
                  <div style={{ flex: 1, height: 6, background: 'rgba(255,255,255,0.08)', borderRadius: 3, overflow: 'hidden' }}>
                    <div style={{ height: '100%', width: `${Math.min(((stats.articles?.read || 0) / 15) * 100, 100)}%`, background: DESIGN.colors.primaryGradient90, borderRadius: 3 }} />
                  </div>
                  <div style={{ minWidth: 70, textAlign: 'right' }}>
                    <span style={{ fontSize: 14, color: '#a78bfa', fontWeight: 600 }}>{stats.articles?.read || 0}</span>
                    {(stats.articles?.toRead || 0) > 0 && <span style={{ fontSize: 11, color: '#fbbf24', marginLeft: 4 }}>+{stats.articles?.toRead || 0}</span>}
                  </div>
                </div>
                
                {/* Calendar */}
                <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                  <span style={{ fontSize: 18, width: 24, textAlign: 'center' }}>📅</span>
                  <span style={{ width: 60, fontSize: 13, color: 'rgba(255,255,255,0.6)', fontWeight: 500 }}>Calendar</span>
                  <div style={{ flex: 1, height: 6, background: 'rgba(255,255,255,0.08)', borderRadius: 3, overflow: 'hidden' }}>
                    <div style={{ height: '100%', width: `${Math.min((((stats.events || 0) + (stats.bookings || 0)) / 20) * 100, 100)}%`, background: 'linear-gradient(90deg, #3b82f6, #60a5fa)', borderRadius: 3 }} />
                  </div>
                  <div style={{ minWidth: 70, textAlign: 'right' }}>
                    <span style={{ fontSize: 14, color: '#3b82f6', fontWeight: 600 }}>{(stats.events || 0) + (stats.bookings || 0)}</span>
                  </div>
                </div>
                
                {/* Badges */}
                <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                  <span style={{ fontSize: 18, width: 24, textAlign: 'center' }}>🎖️</span>
                  <span style={{ width: 60, fontSize: 13, color: 'rgba(255,255,255,0.6)', fontWeight: 500 }}>Badges</span>
                  <div style={{ flex: 1, height: 6, background: 'rgba(255,255,255,0.08)', borderRadius: 3, overflow: 'hidden' }}>
                    <div style={{ height: '100%', width: `${Math.min((memberAchievements.filter(a => a.tier).length / 11) * 100, 100)}%`, background: 'linear-gradient(90deg, #f59e0b, #fbbf24)', borderRadius: 3 }} />
                  </div>
                  <div style={{ minWidth: 70, textAlign: 'right' }}>
                    <span style={{ fontSize: 14, color: '#fbbf24', fontWeight: 600 }}>{memberAchievements.filter(a => a.tier).length}</span>
                    <span style={{ fontSize: 11, color: 'rgba(255,255,255,0.4)' }}>/11</span>
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* Achievements Section - Compact design with modal */}
          {filteredMemberAchievements.length > 0 && (() => {
            // Calculate achievement totals
            let achTotalLikes = 0;
            let achTotalComments = 0;
            filteredMemberAchievements.forEach(a => {
              const r = achievementReactions[a.id] || {};
              achTotalLikes += r.likesCount || 0;
              achTotalComments += r.commentsCount || 0;
            });
            const tierColors = { bronze: TIER_COLORS.bronze.text, silver: TIER_COLORS.silver.text, gold: TIER_COLORS.gold.text, platinum: TIER_COLORS.platinum.text };
            
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
                  <span style={{ flex: 1, fontSize: 15, fontWeight: 600, color: '#fff' }}>Achievements <span style={{ color: 'rgba(255,255,255,0.4)', fontWeight: 400 }}>({filteredMemberAchievements.length})</span></span>
                  <span style={{ display: 'flex', alignItems: 'center', gap: 3, fontSize: 13, color: achTotalLikes > 0 ? '#ef4444' : 'rgba(255,255,255,0.3)' }}>
                    <Heart size={14} fill={achTotalLikes > 0 ? '#ef4444' : 'none'} color={achTotalLikes > 0 ? '#ef4444' : 'rgba(255,255,255,0.3)'} />{achTotalLikes}
                  </span>
                  <span style={{ display: 'flex', alignItems: 'center', gap: 3, fontSize: 13, color: achTotalComments > 0 ? '#3b82f6' : 'rgba(255,255,255,0.3)' }}>
                    <MessageCircle size={14} fill={achTotalComments > 0 ? '#3b82f6' : 'none'} color={achTotalComments > 0 ? '#3b82f6' : 'rgba(255,255,255,0.3)'} />{achTotalComments}
                  </span>
                  <ChevronDown size={18} color="rgba(255,255,255,0.4)" style={{ transform: expandedAchievements ? 'rotate(180deg)' : 'rotate(0)', transition: 'transform 0.2s' }} />
                </button>

                {expandedAchievements && (
                  <div style={{ padding: '0 16px 16px', display: 'flex', flexDirection: 'column', gap: 8 }}>
                    {filteredMemberAchievements.map(achievement => {
                      const reactions = achievementReactions[achievement.id] || { likesCount: 0, commentsCount: 0, userLiked: false, comments: [] };
                      const hasLikes = reactions.likesCount > 0;
                      const hasComments = reactions.commentsCount > 0;
                      
                      return (
                        <div key={achievement.id} style={{ background: 'rgba(255,255,255,0.05)', borderRadius: 12, overflow: 'hidden' }}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '12px 14px' }}>
                            {/* Icon - clickable to open modal */}
                            <button
                              onClick={() => setSelectedAchievementForModal(achievement)}
                              style={{ fontSize: 28, background: 'none', border: 'none', cursor: 'pointer', padding: 0 }}
                            >
                              {achievement.icon || '🏆'}
                            </button>
                            
                            {/* Name + Badge - clickable to open modal */}
                            <button
                              onClick={() => setSelectedAchievementForModal(achievement)}
                              style={{ flex: 1, background: 'none', border: 'none', cursor: 'pointer', padding: 0, textAlign: 'left' }}
                            >
                              <div style={{ fontSize: 14, color: '#fff', fontWeight: 600, marginBottom: 4 }}>{achievement.name}</div>
                              {achievement.tier && (
                                <span style={{ fontSize: 10, padding: '3px 8px', borderRadius: 8, background: `${tierColors[achievement.tier]}20`, color: tierColors[achievement.tier], fontWeight: 600, textTransform: 'uppercase' }}>
                                  {achievement.tier}
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
                )}
              </div>
            );
          })()}
          
          {/* Achievement Detail Modal */}
          {selectedAchievementForModal && (() => {
            const a = selectedAchievementForModal;
            const tierColorsLocal = TIER_COLORS;
            const tierLabelsLocal = TIER_LABELS;
            const tc = tierColorsLocal[a.tier] || { bg: 'rgba(255,255,255,0.05)', border: 'rgba(255,255,255,0.1)', text: 'rgba(255,255,255,0.4)' };
            
            return (
              <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.85)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 200, padding: 16 }} onClick={() => setSelectedAchievementForModal(null)}>
                <div style={{ background: '#0a0a1a', border: '1px solid rgba(255,255,255,0.1)', borderRadius: DESIGN.radius.xxl, padding: 24, width: '100%', maxWidth: 400, maxHeight: '80vh', overflow: 'auto' }} onClick={e => e.stopPropagation()}>
                  
                  {/* Header with close button */}
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
                    <h3 style={{ fontSize: 16, fontWeight: 600, color: '#fff', margin: 0 }}>Achievement Details</h3>
                    <button onClick={() => setSelectedAchievementForModal(null)} style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 4 }}>
                      <X size={20} color="rgba(255,255,255,0.5)" />
                    </button>
                  </div>
                  
                  {/* Two-column info grid */}
                  <div style={{ display: 'flex', gap: 12, marginBottom: 20 }}>
                    {/* Achievement info */}
                    <div style={{ flex: 1, display: 'flex', alignItems: 'center', gap: 14, padding: 16, background: tc.bg, borderRadius: 16, border: `1px solid ${tc.border}` }}>
                      <div style={{ width: 52, height: 52, borderRadius: 14, background: 'rgba(0,0,0,0.2)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 28 }}>
                        {a.icon || '🏆'}
                      </div>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontSize: 17, fontWeight: 700, color: '#fff', marginBottom: 6 }}>{a.name}</div>
                        {a.tier && (
                          <span style={{ display: 'inline-block', padding: '4px 12px', background: 'rgba(0,0,0,0.2)', border: `1px solid ${tc.border}`, borderRadius: 12, fontSize: 11, fontWeight: 700, color: tc.text, textTransform: 'uppercase' }}>
                            {tierLabelsLocal[a.tier]}
                          </span>
                        )}
                      </div>
                    </div>
                    
                    {/* Progress box */}
                    {a.progress !== undefined && (
                      <div style={{ width: 100, padding: 16, background: 'rgba(139,92,246,0.1)', borderRadius: 16, border: '1px solid rgba(139,92,246,0.2)', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center' }}>
                        <div style={{ fontSize: 22, fontWeight: 700, color: '#a78bfa', marginBottom: 2 }}>{a.progress || 0}</div>
                        <div style={{ fontSize: 10, color: 'rgba(255,255,255,0.5)', textTransform: 'uppercase', fontWeight: 600 }}>Progress</div>
                        {a.nextTierThreshold && (
                          <div style={{ width: '100%', height: 4, background: 'rgba(255,255,255,0.1)', borderRadius: 2, marginTop: 8, overflow: 'hidden' }}>
                            <div style={{ height: '100%', width: `${Math.min((a.progress / a.nextTierThreshold) * 100, 100)}%`, background: '#a78bfa', borderRadius: 2 }} />
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                  
                  {/* Tiers - vertical list with checkmarks like Profile */}
                  {a.tiers && (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                      {Object.entries(a.tiers).map(([tier, threshold]) => {
                        const isEarned = (a.progress || 0) >= threshold;
                        const tc2 = tierColorsLocal[tier] || { bg: 'rgba(255,255,255,0.03)', border: 'rgba(255,255,255,0.08)', text: 'rgba(255,255,255,0.4)' };
                        return (
                          <div key={tier} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: 12, background: isEarned ? tc2.bg : 'rgba(255,255,255,0.03)', border: `1px solid ${isEarned ? tc2.border : 'rgba(255,255,255,0.08)'}`, borderRadius: 12 }}>
                            <div style={{ width: 28, height: 28, borderRadius: '50%', background: isEarned ? tc2.bg : 'rgba(255,255,255,0.05)', border: `2px solid ${isEarned ? tc2.text : 'rgba(255,255,255,0.2)'}`, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                              {isEarned && <Check size={14} color={tc2.text} />}
                            </div>
                            <div style={{ flex: 1 }}>
                              <span style={{ fontSize: 13, fontWeight: 600, color: isEarned ? tc2.text : 'rgba(255,255,255,0.5)' }}>{tierLabelsLocal[tier]}</span>
                            </div>
                            <span style={{ fontSize: 13, color: isEarned ? tc2.text : 'rgba(255,255,255,0.4)' }}>{threshold}</span>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              </div>
            );
          })()}

          {/* Mastered Tricks Section */}
          {memberTricks.length > 0 && (() => {
            // Calculate totals for header
            let tricksTotalLikes = 0;
            let tricksTotalComments = 0;
            memberTricks.forEach(t => {
              const r = trickReactions[t.trick_id] || {};
              tricksTotalLikes += r.likesCount || 0;
              tricksTotalComments += r.commentsCount || 0;
            });
            return (
            <div style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.08)', borderRadius: 16, overflow: 'hidden' }}>
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
                <Award size={18} color="#a78bfa" />
                <span style={{ flex: 1, fontSize: 15, fontWeight: 600, color: '#fff' }}>Mastered Tricks <span style={{ color: 'rgba(255,255,255,0.4)', fontWeight: 400 }}>({memberTricks.length})</span></span>
                <span style={{ display: 'flex', alignItems: 'center', gap: 3, fontSize: 13, color: tricksTotalLikes > 0 ? '#ef4444' : 'rgba(255,255,255,0.3)' }}>
                  <Heart size={14} fill={tricksTotalLikes > 0 ? '#ef4444' : 'none'} color={tricksTotalLikes > 0 ? '#ef4444' : 'rgba(255,255,255,0.3)'} />{tricksTotalLikes}
                </span>
                <span style={{ display: 'flex', alignItems: 'center', gap: 3, fontSize: 13, color: tricksTotalComments > 0 ? '#3b82f6' : 'rgba(255,255,255,0.3)' }}>
                  <MessageCircle size={14} fill={tricksTotalComments > 0 ? '#3b82f6' : 'none'} color={tricksTotalComments > 0 ? '#3b82f6' : 'rgba(255,255,255,0.3)'} />{tricksTotalComments}
                </span>
                <ChevronDown size={18} color="rgba(255,255,255,0.4)" style={{ transform: expandedMasteredTricks ? 'rotate(180deg)' : 'rotate(0)', transition: 'transform 0.2s' }} />
              </button>

              {expandedMasteredTricks && (
              <div style={{ padding: '0 16px 16px', display: 'flex', flexDirection: 'column', gap: 8 }}>
                {categoryOrder.filter(cat => tricksByCategory[cat]?.length > 0).map(cat => {
                  const tricks = tricksByCategory[cat] || [];
                  const isExpanded = expandedCategories[cat];
                  const { totalLikes, totalComments } = getCategoryTotals(tricks);
                  
                  return (
                    <div key={cat} style={{ background: 'rgba(255,255,255,0.03)', borderRadius: 12, overflow: 'hidden' }}>
                      <button
                        onClick={() => toggleCategory(cat)}
                        style={{
                          width: '100%',
                          display: 'flex',
                          alignItems: 'center',
                          gap: 10,
                          padding: '12px 14px',
                          background: 'none',
                          border: 'none',
                          cursor: 'pointer',
                          textAlign: 'left'
                        }}
                      >
                        <span style={{ fontSize: 20 }}>{categoryIcons[cat]}</span>
                        <span style={{ flex: 1, fontSize: 14, fontWeight: 600, color: '#fff' }}>
                          {categoryNames[cat]} <span style={{ color: 'rgba(255,255,255,0.4)', fontWeight: 400 }}>({tricks.length})</span>
                        </span>
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
                          {tricks.map(trick => {
                            const reactions = trickReactions[trick.trick_id] || { likesCount: 0, commentsCount: 0, userLiked: false, comments: [] };
                            const isCommentsExpanded = expandedTricks[trick.trick_id];
                            const hasLikes = reactions.likesCount > 0;
                            const hasComments = reactions.commentsCount > 0;
                            
                            return (
                              <div key={trick.id} style={{ background: 'rgba(255,255,255,0.05)', borderRadius: 10, overflow: 'hidden' }}>
                                <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '12px 14px' }}>
                                  <div 
                                    onClick={() => onNavigateToTrick && onNavigateToTrick({ id: trick.trick_id, public_id: trick.public_id })}
                                    style={{ flex: 1, cursor: onNavigateToTrick ? 'pointer' : 'default', display: 'flex', alignItems: 'center', gap: 6 }}
                                  >
                                    <span style={{ fontSize: 14, color: '#fff', fontWeight: 500 }}>{trick.name}</span>
                                    {onNavigateToTrick && (
                                      <ChevronRight size={14} color="rgba(139,92,246,0.6)" />
                                    )}
                                  </div>
                                  
                                  {/* Like button - always show count */}
                                  <button
                                    onClick={() => handleLike(trick.trick_id)}
                                    style={{
                                      display: 'flex',
                                      alignItems: 'center',
                                      gap: 5,
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
                                    onClick={() => openCommentModal('trick', trick.trick_id, reactions.comments || [])}
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
                      )}
                    </div>
                  );
                })}
              </div>
              )}
            </div>
            );
          })()}

          {/* Empty state if no achievements and no tricks */}
          {filteredMemberAchievements.length === 0 && memberTricks.length === 0 && memberFeed.length === 0 && (
            <div style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.08)', borderRadius: 16, padding: 32, textAlign: 'center' }}>
              <Award size={40} style={{ opacity: 0.3, marginBottom: 12, color: 'rgba(255,255,255,0.5)' }} />
              <p style={{ margin: 0, fontSize: 13, color: 'rgba(255,255,255,0.5)' }}>No progress yet</p>
            </div>
          )}

          {/* History Section - Activity Feed */}
          {memberFeed.length > 0 && (() => {
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
                  <Clock size={20} color="#60a5fa" />
                  <span style={{ flex: 1, fontSize: 15, fontWeight: 600, color: '#fff' }}>History <span style={{ color: 'rgba(255,255,255,0.4)', fontWeight: 400 }}>({memberFeed.length})</span></span>
                  <ChevronDown size={18} color="rgba(255,255,255,0.4)" style={{ transform: expandedHistory ? 'rotate(180deg)' : 'rotate(0)', transition: 'transform 0.2s' }} />
                </button>

                {expandedHistory && (
                  <div style={{ padding: '0 16px 16px', display: 'flex', flexDirection: 'column', gap: 6 }}>
                    {memberFeed.map((item, idx) => {
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
        </div>
        
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
                  handleAddComment(commentModal.id, content);
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
              onNavigateToUser={(userObj) => userObj.id && navigateToUserProfile(userObj.id)}
              currentUserId={user?.id}
            />
          );
        })()}
      </div>
    );
  }

  if (showSearch) {
    return (
      <div style={{ minHeight: '100vh', background: 'transparent', paddingBottom: 100, position: 'relative' }}>
        
        <div style={{ maxWidth: 700, margin: '0 auto', padding: 16, position: 'relative', zIndex: 10 }}>
          <button onClick={() => { setShowSearch(false); setSearchQuery(''); }} style={{ display: 'flex', alignItems: 'center', gap: 8, background: 'none', border: 'none', color: 'rgba(255,255,255,0.6)', fontSize: 14, cursor: 'pointer', marginBottom: 20, padding: 0 }}>
            <ChevronLeft size={20} /> Back
          </button>
          <h1 style={{ fontSize: 24, fontWeight: 700, color: '#fff', marginBottom: 20 }}>Add Friend</h1>
          <div style={{ position: 'relative', marginBottom: 20 }}>
            <Search size={18} style={{ position: 'absolute', left: 14, top: '50%', transform: 'translateY(-50%)', color: 'rgba(255,255,255,0.4)' }} />
            <input value={searchQuery} onChange={e => setSearchQuery(e.target.value)} placeholder="Search by name..." style={{ width: '100%', padding: '14px 14px 14px 44px', background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.1)', borderRadius: 12, color: '#fff', fontSize: 15, outline: 'none', boxSizing: 'border-box' }} />
          </div>
          {searchResults.length > 0 ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              {searchResults.map(person => (
                <div key={person.id} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.08)', borderRadius: 16, padding: 16 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                    <div style={{ width: 44, height: 44, borderRadius: '50%', background: DESIGN.colors.avatarGradient, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 16, fontWeight: 600, color: '#fff' }}>{person.username?.[0]?.toUpperCase()}</div>
                    <div>
                      <div style={{ fontSize: 15, fontWeight: 600, color: '#fff' }}>{person.display_name || person.username}</div>
                      <div style={{ fontSize: 12, color: 'rgba(255,255,255,0.5)' }}>@{person.username}</div>
                    </div>
                  </div>
                  <button onClick={() => { onSendRequest(person.id); showToast('Friend request sent!'); }} style={{ padding: '8px 16px', background: DESIGN.colors.primaryGradient, border: 'none', borderRadius: 10, color: '#fff', fontSize: 13, fontWeight: 600, cursor: 'pointer' }}>Add</button>
                </div>
              ))}
            </div>
          ) : searchQuery ? (
            <div style={{ textAlign: 'center', padding: 40, color: 'rgba(255,255,255,0.5)' }}>No users found</div>
          ) : (
            <div style={{ textAlign: 'center', padding: 40, color: 'rgba(255,255,255,0.5)' }}>Search for users to add</div>
          )}
        </div>
      </div>
    );
  }

  return (
    <div style={{ minHeight: '100vh', background: 'transparent', paddingBottom: 100, position: 'relative' }}>
      
      {/* Leaderboard Modal */}
      {showLeaderboard && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.85)', zIndex: 100, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }} onClick={() => setShowLeaderboard(false)}>
          <div style={{ background: 'linear-gradient(135deg, rgba(20,20,35,0.98), rgba(10,10,20,0.98))', border: '1px solid rgba(255,255,255,0.1)', borderRadius: 20, width: '100%', maxWidth: 400, maxHeight: '80vh', overflow: 'auto' }} onClick={e => e.stopPropagation()}>
            <div style={{ padding: 20, borderBottom: '1px solid rgba(255,255,255,0.1)', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <h2 style={{ margin: 0, fontSize: 20, fontWeight: 700, color: '#fff', display: 'flex', alignItems: 'center', gap: 10 }}>
                <Trophy size={24} color="#fbbf24" /> Leaderboard
              </h2>
              <button onClick={() => setShowLeaderboard(false)} style={{ background: 'none', border: 'none', color: 'rgba(255,255,255,0.5)', cursor: 'pointer', padding: 8 }}>
                <X size={20} />
              </button>
            </div>
            
            {/* Leaderboard Filter - Friends / World */}
            <div style={{ padding: '12px 16px', borderBottom: '1px solid rgba(255,255,255,0.05)', display: 'flex', gap: 8 }}>
              {[
                { id: 'friends', label: 'Friends', icon: Users },
                { id: 'world', label: 'World', icon: Globe }
              ].map(f => (
                <button 
                  key={f.id} 
                  onClick={() => setLeaderboardFilter(f.id)} 
                  style={{ 
                    flex: 1, 
                    padding: '10px 16px', 
                    borderRadius: 12, 
                    fontSize: 14, 
                    fontWeight: 600, 
                    border: 'none', 
                    cursor: 'pointer', 
                    background: leaderboardFilter === f.id ? 'linear-gradient(135deg,#fbbf24,#f59e0b)' : 'rgba(255,255,255,0.08)', 
                    color: leaderboardFilter === f.id ? '#000' : 'rgba(255,255,255,0.6)', 
                    display: 'flex', 
                    alignItems: 'center', 
                    justifyContent: 'center', 
                    gap: 8 
                  }}
                >
                  <f.icon size={16} />
                  {f.label}
                </button>
              ))}
            </div>
            
            <div style={{ padding: 16 }}>
              {/* Get filtered members based on leaderboard filter */}
              {(() => {
                const leaderboardMembers = leaderboardFilter === 'friends' 
                  ? allMembers.filter(m => favorites.users?.includes(m.id))
                  : allMembers;
                
                // Most Tricks Mastered
                const tricksSorted = [...leaderboardMembers].sort((a, b) => (b.mastered || 0) - (a.mastered || 0)).slice(0, 5);
                const tricksMyRank = [...leaderboardMembers].sort((a, b) => (b.mastered || 0) - (a.mastered || 0)).findIndex(m => m.id === user?.id) + 1;
                const tricksLeader = tricksSorted[0];
                const tricksMyStats = leaderboardMembers.find(m => m.id === user?.id);
                const tricksGap = tricksLeader ? (tricksLeader.mastered || 0) - (tricksMyStats?.mastered || 0) : 0;
                
                // Most Likes Received
                const likesSorted = [...leaderboardMembers].sort((a, b) => (b.likes_received || 0) - (a.likes_received || 0)).slice(0, 5);
                const likesMyRank = [...leaderboardMembers].sort((a, b) => (b.likes_received || 0) - (a.likes_received || 0)).findIndex(m => m.id === user?.id) + 1;
                const likesLeader = likesSorted[0];
                const likesMyStats = leaderboardMembers.find(m => m.id === user?.id);
                const likesGap = likesLeader ? (likesLeader.likes_received || 0) - (likesMyStats?.likes_received || 0) : 0;
                
                // Most Achievements
                const achievementsSorted = [...leaderboardMembers].sort((a, b) => (b.achievements_count || 0) - (a.achievements_count || 0)).slice(0, 5);
                const achievementsMyRank = [...leaderboardMembers].sort((a, b) => (b.achievements_count || 0) - (a.achievements_count || 0)).findIndex(m => m.id === user?.id) + 1;
                const achievementsLeader = achievementsSorted[0];
                const achievementsMyStats = leaderboardMembers.find(m => m.id === user?.id);
                const achievementsGap = achievementsLeader ? (achievementsLeader.achievements_count || 0) - (achievementsMyStats?.achievements_count || 0) : 0;
                
                const renderLeaderboardSection = (title, icon, sorted, myRank, gap, valueKey, valueColor) => (
                  <div style={{ marginBottom: 20 }}>
                    <h3 style={{ fontSize: 14, fontWeight: 600, color: 'rgba(255,255,255,0.7)', marginBottom: 12, display: 'flex', alignItems: 'center', gap: 8 }}>
                      <span style={{ fontSize: 18 }}>{icon}</span> {title}
                    </h3>
                    {sorted.length === 0 ? (
                      <p style={{ fontSize: 13, color: 'rgba(255,255,255,0.4)', textAlign: 'center', padding: 16 }}>
                        {leaderboardFilter === 'friends' ? 'Add friends to see rankings!' : 'No data yet'}
                      </p>
                    ) : (
                      <>
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                          {sorted.map((m, i) => {
                            const isMe = m.id === user?.id;
                            const medal = i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : `#${i+1}`;
                            return (
                              <div key={m.id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 12px', background: isMe ? 'rgba(139,92,246,0.15)' : 'rgba(255,255,255,0.03)', borderRadius: 10, border: isMe ? '1px solid rgba(139,92,246,0.3)' : '1px solid transparent' }}>
                                <span style={{ width: 28, textAlign: 'center', fontSize: i < 3 ? 18 : 13, color: 'rgba(255,255,255,0.5)' }}>{medal}</span>
                                {m.avatar_base64 ? (
                                  <img src={m.avatar_base64} alt="" style={{ width: 32, height: 32, borderRadius: '50%', objectFit: 'cover' }} />
                                ) : (
                                  <div style={{ width: 32, height: 32, borderRadius: '50%', background: DESIGN.colors.avatarGradient, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 13, fontWeight: 600, color: '#fff' }}>{m.username?.[0]?.toUpperCase()}</div>
                                )}
                                <span style={{ flex: 1, fontSize: 14, fontWeight: isMe ? 600 : 500, color: isMe ? '#a78bfa' : '#fff' }}>{isMe ? 'You' : (m.display_name || m.username)}</span>
                                <span style={{ fontSize: 14, fontWeight: 700, color: valueColor }}>{m[valueKey] || 0}</span>
                              </div>
                            );
                          })}
                        </div>
                        {myRank > 5 && <p style={{ fontSize: 12, color: 'rgba(255,255,255,0.4)', marginTop: 8, textAlign: 'center' }}>You're #{myRank}</p>}
                        {gap > 0 && <p style={{ fontSize: 12, color: '#fbbf24', marginTop: 8, textAlign: 'center' }}>⬆️ {gap} more to reach #1</p>}
                      </>
                    )}
                  </div>
                );
                
                return (
                  <>
                    {renderLeaderboardSection('Most Tricks Mastered', '🏋️', tricksSorted, tricksMyRank, tricksGap, 'mastered', '#22c55e')}
                    {renderLeaderboardSection('Most Likes Received', '❤️', likesSorted, likesMyRank, likesGap, 'likes_received', '#ef4444')}
                    {renderLeaderboardSection('Most Achievements', '🏆', achievementsSorted, achievementsMyRank, achievementsGap, 'achievements_count', '#fbbf24')}
                  </>
                );
              })()}
            </div>
          </div>
        </div>
      )}
      
      <div style={{ maxWidth: 700, margin: '0 auto', padding: 16, position: 'relative', zIndex: 10 }}>
        {/* Header with Leaderboard button - single row on mobile */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 16 }}>
          <div style={{ display: 'flex', gap: 6, flex: 1, overflow: 'auto', WebkitOverflowScrolling: 'touch' }}>
            {[
              { id: 'friends', label: 'Friends', count: allMembers.filter(m => favorites.users?.includes(m.id)).length }, 
              { id: 'fans', label: 'Fans', count: allMembers.filter(m => followers.includes(m.id)).length },
              { id: 'add', label: 'Add', count: notFollowedMembers.length, icon: Plus }
            ].map(f => (
              <button key={f.id} onClick={() => { setFilter(f.id); setAddSearchQuery(''); }} style={{ padding: '8px 14px', borderRadius: 20, fontSize: 13, fontWeight: 600, border: 'none', cursor: 'pointer', whiteSpace: 'nowrap', background: filter === f.id ? DESIGN.colors.primaryGradient : 'rgba(255,255,255,0.08)', color: filter === f.id ? '#fff' : 'rgba(255,255,255,0.6)', display: 'flex', alignItems: 'center', gap: 5, flexShrink: 0 }}>
                {f.icon && <f.icon size={14} />}
                {f.label}
                <span style={{ fontSize: 11, opacity: 0.7 }}>({f.count})</span>
              </button>
            ))}
          </div>
          <button onClick={() => { haptic.light(); setShowLeaderboard(true); }} className="btn-press tap-highlight" style={{ width: 42, height: 42, borderRadius: 12, background: 'linear-gradient(135deg, rgba(251,191,36,0.15), rgba(251,191,36,0.05))', border: '1px solid rgba(251,191,36,0.3)', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', flexShrink: 0 }}>
            <Trophy size={20} color="#fbbf24" />
          </button>
        </div>
        
        {/* Search bar for Add tab */}
        {filter === 'add' && (
          <div style={{ position: 'relative', marginBottom: 16 }}>
            <Search size={18} style={{ position: 'absolute', left: 14, top: '50%', transform: 'translateY(-50%)', color: 'rgba(255,255,255,0.4)' }} />
            <input 
              value={addSearchQuery} 
              onChange={e => setAddSearchQuery(e.target.value)} 
              placeholder="Search people to follow..." 
              style={{ width: '100%', padding: '12px 14px 12px 44px', background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.1)', borderRadius: 12, color: '#fff', fontSize: 14, outline: 'none', boxSizing: 'border-box' }} 
            />
            {addSearchQuery && (
              <button onClick={() => setAddSearchQuery('')} style={{ position: 'absolute', right: 12, top: '50%', transform: 'translateY(-50%)', background: 'none', border: 'none', color: 'rgba(255,255,255,0.4)', cursor: 'pointer', padding: 4 }}>
                <X size={16} />
              </button>
            )}
          </div>
        )}

        {friendRequests.length > 0 && (
          <div style={{ marginBottom: 24 }}>
            <h2 style={{ fontSize: 16, fontWeight: 600, color: '#fff', marginBottom: 12 }}>Friend Requests ({friendRequests.length})</h2>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {friendRequests.map(req => (
                <div key={req.id} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', background: 'rgba(139,92,246,0.1)', border: '1px solid rgba(139,92,246,0.3)', borderRadius: 12, padding: '10px 14px' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                    <div style={{ width: 36, height: 36, borderRadius: DESIGN.radius.full, background: DESIGN.colors.primaryGradient, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 14, fontWeight: 600, color: '#fff' }}>{req.username?.[0]?.toUpperCase()}</div>
                    <div style={{ fontSize: 14, fontWeight: 600, color: '#fff' }}>{req.username}</div>
                  </div>
                  <div style={{ display: 'flex', gap: 6 }}>
                    <button onClick={() => { haptic.success(); onAcceptRequest(req.id); }} className="btn-press" style={{ width: 32, height: 32, borderRadius: DESIGN.radius.md, background: DESIGN.colors.success, border: 'none', color: '#fff', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}><Check size={16} /></button>
                    <button onClick={() => { haptic.light(); onDeclineRequest(req.id); }} className="btn-press" style={{ width: 32, height: 32, borderRadius: DESIGN.radius.md, background: 'rgba(255,255,255,0.1)', border: 'none', color: '#fff', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}><X size={16} /></button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Compact List View */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {appLoading && sortedMembers.length === 0 ? (
            <>{Array.from({ length: 5 }, (_, i) => <CrewMemberSkeleton key={i} />)}</>
          ) : sortedMembers.length === 0 ? (
            <div className="fade-in" style={{ textAlign: 'center', padding: 40, color: 'rgba(255,255,255,0.5)' }}>
              {filter === 'friends' ? (
                <>
                  <EmptyStateIllustration type="friends" />
                  <p style={{ marginTop: 16, fontSize: 15, fontWeight: 500 }}>No friends yet</p>
                  <p style={{ fontSize: 12, marginTop: 8, color: 'rgba(255,255,255,0.4)' }}>Tap the ⭐ on any crew member to add them</p>
                </>
              ) : filter === 'fans' ? (
                <>
                  <EmptyStateIllustration type="friends" />
                  <p style={{ marginTop: 16, fontSize: 15, fontWeight: 500 }}>No fans yet</p>
                  <p style={{ fontSize: 12, marginTop: 8, color: 'rgba(255,255,255,0.4)' }}>Share your progress to get more fans!</p>
                </>
              ) : filter === 'add' ? (
                <>
                  <EmptyStateIllustration type="friends" />
                  <p style={{ marginTop: 16, fontSize: 15, fontWeight: 500 }}>
                    {addSearchQuery ? 'No users found' : 'You follow everyone! 🎉'}
                  </p>
                  <p style={{ fontSize: 12, marginTop: 8, color: 'rgba(255,255,255,0.4)' }}>
                    {addSearchQuery ? 'Try a different search' : 'Great job connecting with the crew!'}
                  </p>
                </>
              ) : (
                <>
                  <EmptyStateIllustration type="friends" />
                  <p style={{ marginTop: 16, fontSize: 15, fontWeight: 500 }}>Time to add some friends! 🎉</p>
                  <p style={{ fontSize: 12, marginTop: 8, color: 'rgba(255,255,255,0.4)' }}>Use the search to find people</p>
                </>
              )}
            </div>
          ) : sortedMembers.map(member => {
            const isFavorite = favorites.users?.includes(member.id);
            const isFollower = followers.includes(member.id);
            return (
              <div 
                key={member.id} 
                onClick={() => { haptic.light(); setSelectedMember(member); window.history.pushState(null, '', '#crew/' + (member.public_id || member.id)); }} 
                className="card-hover tap-highlight" 
                style={{ 
                  background: 'rgba(255,255,255,0.03)', 
                  border: '1px solid rgba(255,255,255,0.08)', 
                  borderRadius: 12, 
                  padding: '12px 14px', 
                  cursor: 'pointer', 
                  display: 'flex', 
                  alignItems: 'center', 
                  gap: 12 
                }}
              >
                {/* Avatar */}
                {member.avatar_base64 ? (
                  <img src={member.avatar_base64} alt="" style={{ width: 40, height: 40, borderRadius: DESIGN.radius.full, objectFit: 'cover', flexShrink: 0 }} />
                ) : (
                  <div style={{ width: 40, height: 40, borderRadius: DESIGN.radius.full, background: DESIGN.colors.primaryGradient, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 15, fontWeight: 600, color: '#fff', flexShrink: 0 }}>{member.username?.[0]?.toUpperCase()}</div>
                )}
                
                {/* Name & Badges - centered */}
                <div style={{ flex: 1, minWidth: 0, textAlign: 'center' }}>
                  <div style={{ fontSize: 14, fontWeight: 600, color: '#fff', marginBottom: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {member.display_name || member.username}
                  </div>
                  <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', justifyContent: 'center' }}>
                    <UserRoleBadges user={member} size="small" centered />
                    {isFollower && filter !== 'fans' && <RoleBadge role="fan" size="small" />}
                  </div>
                </div>
                
                {/* Star Button */}
                <button 
                  onClick={(e) => { haptic.medium(); handleStarClick(e, member.id); }} 
                  className="btn-press tap-highlight" 
                  style={{ background: 'none', border: 'none', padding: 6, cursor: 'pointer', flexShrink: 0 }}
                >
                  <Star size={18} color={isFavorite ? '#fbbf24' : 'rgba(255,255,255,0.4)'} filled={isFavorite} />
                </button>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
};


// ==================== EXPORTS (Global Scope for Babel) ====================


