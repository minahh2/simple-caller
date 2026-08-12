import React, { useEffect, useState } from 'react';
import { supabase } from '../lib/supabaseClient';
import { useAudioAlarm } from '../hooks/useAudioAlarm';
import { translations } from '../lib/i18n';
import { useLanguage } from '../context/LanguageContext';
import { useAuth } from '../context/AuthContext';
import { useToast } from '../context/ToastContext';
import { motion, AnimatePresence } from 'framer-motion';
import { Button } from '../components/ui/Button';
import { Card } from '../components/ui/Card';
import { CheckCircle2, Clock, AlertTriangle, Globe, History, X, Download } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { CallHistoryPanel } from '../components/admin/CallHistoryPanel';

let globalServerTimeOffset = 0;

export default function StaffDashboard({ venueId: propVenueId }) {
  const { lang, changeLanguage } = useLanguage();
  const t = translations[lang] || translations['ar'];
  const { user, loading: authLoading } = useAuth();
  const navigate = useNavigate();
  const toast = useToast();
  const [venueId, setVenueId] = useState(propVenueId);
  const [calls, setCalls] = useState([]);
  const [tables, setTables] = useState([]);
  const [actionButtons, setActionButtons] = useState({});
  const [venueSettings, setVenueSettings] = useState(null);
  const [confirmDismissAllModal, setConfirmDismissAllModal] = useState(null);
  const [showHistory, setShowHistory] = useState(false);
  const [isOffline, setIsOffline] = useState(false);
  const [deferredPrompt, setDeferredPrompt] = useState(null);
  const { isAudioEnabled, enableAudio, startAlarm, stopAlarm } = useAudioAlarm();

  const [isStandalone, setIsStandalone] = useState(false);

  useEffect(() => {
    // Check if running as PWA
    const checkStandalone = () => setIsStandalone(window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone);
    checkStandalone();
    window.matchMedia('(display-mode: standalone)').addEventListener('change', checkStandalone);

    // Pick up the global install prompt if available
    if (window.globalDeferredPrompt) {
      setDeferredPrompt(window.globalDeferredPrompt);
    }
    const handleBeforeInstallPrompt = (e) => {
      e.preventDefault();
      setDeferredPrompt(e);
    };
    window.addEventListener('beforeinstallprompt', handleBeforeInstallPrompt);

    return () => {
      window.matchMedia('(display-mode: standalone)').removeEventListener('change', checkStandalone);
      window.removeEventListener('beforeinstallprompt', handleBeforeInstallPrompt);
    };
  }, []);

  const subscribeToPush = async () => {
    if ('serviceWorker' in navigator && import.meta.env.VITE_VAPID_PUBLIC_KEY && venueId) {
      try {
        const registration = await navigator.serviceWorker.ready;
        const publicVapidKey = import.meta.env.VITE_VAPID_PUBLIC_KEY;
        const urlBase64ToUint8Array = (base64String) => {
          const padding = '='.repeat((4 - base64String.length % 4) % 4);
          const base64 = (base64String + padding).replace(/\-/g, '+').replace(/_/g, '/');
          const rawData = window.atob(base64);
          const outputArray = new Uint8Array(rawData.length);
          for (let i = 0; i < rawData.length; ++i) { outputArray[i] = rawData.charCodeAt(i); }
          return outputArray;
        };
        let subscription = await registration.pushManager.getSubscription();
        if (!subscription) {
          subscription = await registration.pushManager.subscribe({
            userVisibleOnly: true,
            applicationServerKey: urlBase64ToUint8Array(publicVapidKey)
          });
        }
        if (subscription) {
          const subData = JSON.parse(JSON.stringify(subscription));
          await supabase.from('push_subscriptions').upsert({
            venue_id: venueId,
            endpoint: subData.endpoint,
            p256dh: subData.keys.p256dh,
            auth: subData.keys.auth
          }, { onConflict: 'endpoint' });
        }
      } catch (e) {
        console.error('Push subscription failed:', e);
      }
    }
  };

  useEffect(() => {
    if (isStandalone && 'Notification' in window && Notification.permission === 'default') {
      Notification.requestPermission().then(perm => {
        if (perm === 'granted') subscribeToPush();
      });
    } else if (isStandalone && Notification.permission === 'granted') {
      subscribeToPush();
    }
  }, [isStandalone, venueId]);

  const handleInstallClick = async () => {
    if (deferredPrompt) {
      deferredPrompt.prompt();
      const { outcome } = await deferredPrompt.userChoice;
      if (outcome === 'accepted') {
        setDeferredPrompt(null);
      }
    } else {
      const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
      if (isIOS) {
        toast.info(lang === 'ar' 
          ? 'لتثبيت التطبيق على آيفون، اضغط على زر المشاركة ⍐ ثم اختر "إضافة إلى الشاشة الرئيسية".'
          : 'To install on iOS, tap the Share button ⍐ and select "Add to Home Screen".',
          { autoClose: 8000 }
        );
      } else {
        toast.info(lang === 'ar' 
          ? 'التطبيق مثبت بالفعل، أو يرجى النقر على أيقونة التثبيت ⬇️ في شريط العنوان.'
          : 'App is already installed, or click the Install icon ⬇️ in your browser address bar.',
          { autoClose: 6000 }
        );
      }
    }
  };

  // Refs for realtime callback access without resubscribing
  const langRef = React.useRef(lang);
  useEffect(() => { langRef.current = lang; }, [lang]);

  const actionButtonsRef = React.useRef(actionButtons);
  useEffect(() => { actionButtonsRef.current = actionButtons; }, [actionButtons]);

  useEffect(() => {
    setIsOffline(!navigator.onLine);
    const handleOnline = () => setIsOffline(false);
    const handleOffline = () => setIsOffline(true);
    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);
    return () => {
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
    };
  }, []);

  useEffect(() => {
    // Sync client clock with a public time server for accurate response times
    fetch('https://worldtimeapi.org/api/timezone/Etc/UTC')
      .then(res => res.json())
      .then(data => {
        globalServerTimeOffset = new Date(data.utc_datetime).getTime() - Date.now();
      })
      .catch(e => console.log('Time sync failed', e));
  }, []);

  useEffect(() => {
    async function loadVenue() {
      if (propVenueId) {
        setVenueId(propVenueId);
        const { data } = await supabase.from('venues').select('settings').eq('id', propVenueId).single();
        if (data) setVenueSettings(data.settings);
        return;
      }
      if (authLoading) return; // Wait for auth to finish loading
      if (!user) {
        navigate('/admin?mode=login');
        return;
      }
      const { data } = await supabase.from('venues').select('id, settings').eq('tenant_id', user.id).single();
      if (data) {
        setVenueId(data.id);
        setVenueSettings(data.settings);
      }
    }
    loadVenue();
  }, [user, authLoading, propVenueId, navigate]);

  useEffect(() => {
    if (!venueId || !venueSettings) return;
    
    fetchActiveCalls();
    fetchTables();
    fetchButtons();

    const callSub = supabase
      .channel(`venue_calls_${venueId}`)
      .on('postgres_changes', {
        event: 'INSERT',
        schema: 'public',
        table: 'service_calls',
        filter: `venue_id=eq.${venueId}`
      }, async (payload) => {
        // Fetch table details to see if it's vacant
        const { data: tableData } = await supabase
          .from('tables_devices')
          .select('label, is_occupied')
          .eq('id', payload.new.table_id)
          .single();
          
        const newCall = { ...payload.new, tables_devices: { label: tableData?.label, is_occupied: tableData?.is_occupied } };
        setCalls(prev => [newCall, ...prev]);
        
        // Smart Muting for vacant tables based on settings
        if (venueSettings?.security?.table_lifecycle_enabled && tableData?.is_occupied === false) {
          // Do nothing, alarm is muted
        } else {
          startAlarm({
            volume: venueSettings?.alarm_volume || 100,
            style: venueSettings?.alarm_style || 'looping',
            timeout: venueSettings?.alarm_auto_timeout_seconds || 0
          });

          // Trigger OS Notification
          if ('Notification' in window && Notification.permission === 'granted') {
            const currentLang = langRef.current;
            const buttonsDict = actionButtonsRef.current;
            const buttonLabel = buttonsDict[payload.new.button_key] ? buttonsDict[payload.new.button_key][`label_${currentLang}`] : payload.new.button_key;
            const tableLabel = tableData?.label || `${currentLang === 'ar' ? 'طاولة' : 'Table'}`;
            
            const title = `${currentLang === 'ar' ? 'طلب جديد من' : 'New request from'} ${tableLabel}`;
            const options = {
              body: `${currentLang === 'ar' ? 'يطلب:' : 'Requesting:'} ${buttonLabel}`,
              icon: '/icon-192.png',
              requireInteraction: true,
              vibrate: [200, 100, 200, 100, 200, 100, 200]
            };
            
            try {
              if ('serviceWorker' in navigator) {
                navigator.serviceWorker.ready.then(registration => {
                  registration.showNotification(title, options);
                }).catch(() => {
                  const notif = new Notification(title, options);
                  notif.onclick = () => window.focus();
                });
              } else {
                const notif = new Notification(title, options);
                notif.onclick = () => window.focus();
              }
            } catch (e) {
              console.error('Notification API failed:', e);
            }
          }
        }
      })
      .on('postgres_changes', {
        event: 'UPDATE',
        schema: 'public',
        table: 'service_calls',
        filter: `venue_id=eq.${venueId}`
      }, (payload) => {
        if (payload.new.status === 'dismissed' || payload.new.status === 'flagged_spam') {
          setCalls(prev => prev.filter(c => c.id !== payload.new.id));
        } else {
          setCalls(prev => prev.map(c => c.id === payload.new.id ? { ...c, ...payload.new } : c));
        }
      })
      .subscribe();

    const tableSub = supabase
      .channel(`venue_tables_${venueId}`)
      .on('postgres_changes', {
        event: '*',
        schema: 'public',
        table: 'tables_devices',
        filter: `venue_id=eq.${venueId}`
      }, () => {
        fetchTables();
      })
      .subscribe();

    return () => { 
      supabase.removeChannel(callSub); 
      supabase.removeChannel(tableSub);
    };
  }, [venueId, venueSettings, startAlarm]);

  useEffect(() => {
    const pendingCount = calls.filter(c => c.status === 'pending').length;
    if (pendingCount === 0) {
      stopAlarm();
    }
  }, [calls, stopAlarm]);



  async function fetchActiveCalls() {
    const { data } = await supabase
      .from('service_calls')
      .select('*, tables_devices(label, is_occupied)')
      .eq('venue_id', venueId)
      .in('status', ['pending', 'acknowledged'])
      .order('created_at', { ascending: false });

    if (data) setCalls(data);
  }

  async function fetchTables() {
    const { data } = await supabase
      .from('tables_devices')
      .select('id, label, is_active, is_occupied')
      .eq('venue_id', venueId)
      .eq('is_active', true)
      .order('label');
    if (data) setTables(data);
  }

  async function fetchButtons() {
    const { data } = await supabase
      .from('action_buttons')
      .select('button_key, label_en, label_ar')
      .eq('venue_id', venueId);
    if (data) {
      const dict = {};
      data.forEach(b => dict[b.button_key] = b);
      setActionButtons(dict);
    }
  }

  async function handleAcknowledgeCall(callId) {
    await supabase
      .from('service_calls')
      .update({ status: 'acknowledged' })
      .eq('id', callId);
  }

  async function handleDismissCall(callId, createdAt) {
    await supabase
      .from('service_calls')
      .update({ status: 'dismissed' })
      .eq('id', callId);
  }

  async function handleDismissAllConfirmed() {
    if (!confirmDismissAllModal) return;
    
    const dismissTime = new Date().toISOString();
    const callsToDismiss = confirmDismissAllModal;
    setConfirmDismissAllModal(null);
    
    // Optimistic UI
    const callIds = callsToDismiss.map(c => c.id);
    setCalls(prev => prev.filter(c => !callIds.includes(c.id)));
    
    // DB update
    await Promise.all(callsToDismiss.map(call => {
      return supabase
        .from('service_calls')
        .update({ status: 'dismissed' })
        .eq('id', call.id);
    }));
  }

  async function toggleTableOccupancy(tableId, currentStatus) {
    // Optimistic UI update for instant feedback
    setTables(prev => prev.map(t => t.id === tableId ? { ...t, is_occupied: !currentStatus } : t));
    
    await supabase
      .from('tables_devices')
      .update({ is_occupied: !currentStatus })
      .eq('id', tableId);
  }

  if (!isAudioEnabled) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-[#0F172A] text-white p-4">
        <motion.div initial={{ scale: 0.9, opacity: 0 }} animate={{ scale: 1, opacity: 1 }}>
          <Button 
            onClick={async () => {
              enableAudio();
              if ('Notification' in window) {
                const perm = await Notification.requestPermission();
                if (perm !== 'granted') {
                  toast.error(lang === 'ar' ? 'يرجى تفعيل الإشعارات من إعدادات المتصفح لضمان استلام الطلبات' : 'Please enable notifications in your browser settings to receive alerts');
                } else {
                  await subscribeToPush();
                }
              }
            }}
            size="lg"
            className="animate-pulse-slow shadow-blue-500/50 px-10 h-16 text-xl rounded-2xl"
          >
            {t.start_shift}
          </Button>
        </motion.div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-[#0F172A] text-white p-4 md:p-6 flex flex-col md:flex-row gap-4 relative">
      {isOffline && (
        <div className="absolute top-0 left-0 right-0 bg-red-600/90 text-white text-center py-1.5 font-bold z-[200] text-sm animate-pulse flex items-center justify-center gap-2 shadow-lg backdrop-blur-md">
          <AlertTriangle className="w-4 h-4" />
          {lang === 'ar' ? 'أنت غير متصل بالإنترنت - يرجى التحقق من الشبكة' : 'YOU ARE OFFLINE - Please check your internet connection'}
        </div>
      )}
      
      {/* Left Column: Call Queue */}
      <div className="flex-1 min-w-0">
        <header className="flex justify-between items-center pb-4 mb-6 border-b border-white/10 glass px-4 py-3 rounded-2xl sticky top-4 z-50 shadow-sm">
          <div className="flex items-center gap-3">
            <img src="/icon-192.png" alt="Icon" className="w-8 h-8 object-contain" />
            <h1 className="text-xl font-bold tracking-tight">{t.pending_calls} <span className="bg-blue-600 px-2 py-0.5 rounded-full text-xs mx-2">{calls.length}</span></h1>
          </div>
          <div className="flex items-center gap-2 sm:gap-4">
            <Button 
              variant="ghost" 
              onClick={() => setShowHistory(true)}
              className="text-slate-300 hover:text-white px-2 sm:px-3 h-8"
            >
              <History className="w-4 h-4 mx-1" />
              <span className="hidden sm:inline text-sm">{t.tab_history || "History"}</span>
            </Button>
            <Button 
              variant="ghost" 
              onClick={() => changeLanguage(lang === 'en' ? 'ar' : 'en')}
              className="text-slate-300 hover:text-white px-2 sm:px-3 h-8"
            >
              <Globe className="w-4 h-4 mx-1" />
              <span className="hidden sm:inline text-sm">{lang === 'en' ? 'عربي' : 'English'}</span>
            </Button>
            {!isStandalone && (
              <Button 
                onClick={handleInstallClick}
                className="bg-gradient-to-r from-indigo-500 to-purple-600 hover:from-indigo-400 hover:to-purple-500 text-white font-bold px-3 sm:px-4 h-8 rounded-full shadow-[0_0_15px_rgba(99,102,241,0.5)] border border-indigo-400/30 flex items-center gap-1.5 transition-all hover:scale-105 active:scale-95 animate-pulse-slow relative overflow-hidden group"
              >
                <div className="absolute inset-0 bg-white/20 translate-y-full group-hover:translate-y-0 transition-transform duration-300 ease-out" />
                <Download className="w-4 h-4 relative z-10 animate-bounce" style={{ animationDuration: '2s' }} />
                <span className="hidden sm:inline text-sm relative z-10 shadow-sm">{lang === 'ar' ? 'تثبيت التطبيق' : 'Install App'}</span>
              </Button>
            )}
            <div className="flex items-center gap-2">
              <div className="w-2.5 h-2.5 bg-green-500 rounded-full animate-pulse shadow-[0_0_10px_rgba(34,197,94,0.8)]" />
              <span className="text-xs font-semibold text-slate-300 hidden lg:inline">{t.shift_active}</span>
            </div>
          </div>
        </header>

        <div className="grid grid-cols-1 lg:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4 gap-3">
          <AnimatePresence>
            {Object.values(calls.reduce((acc, call) => {
              const tableId = call.table_id;
              if (!acc[tableId]) {
                acc[tableId] = {
                  table_id: tableId,
                  label: call.tables_devices?.label || 'Table',
                  is_occupied: call.tables_devices?.is_occupied,
                  calls: []
                };
              }
              acc[tableId].calls.push(call);
              return acc;
            }, {})).sort((a, b) => {
              const aTime = Math.min(...a.calls.map(c => new Date(c.created_at).getTime()));
              const bTime = Math.min(...b.calls.map(c => new Date(c.created_at).getTime()));
              return aTime - bTime;
            }).map((group) => {
              const tablePending = group.calls.some(c => c.status === 'pending');
              const isVacant = group.is_occupied === false;
              
              return (
                <motion.div
                  key={group.table_id}
                  initial={{ opacity: 0, scale: 0.9, y: 20 }}
                  animate={{ opacity: 1, scale: 1, y: 0 }}
                  exit={{ opacity: 0, scale: 0.9 }}
                >
                  <Card className={`relative overflow-hidden group ${tablePending ? 'border-red-500/50 animate-pulse-slow shadow-lg shadow-red-500/20' : 'border-amber-500/30'} bg-gradient-to-br from-slate-900 to-slate-800`}>
                    
                    {isVacant && (
                      <div className="absolute top-0 right-0 bg-slate-800 text-slate-400 text-[10px] px-2 py-0.5 rounded-bl font-bold border-b border-l border-white/10">
                        VACANT
                      </div>
                    )}

                    <div className="flex justify-between items-center pt-3 px-3 pb-1 relative z-10">
                      <span className={`text-xl font-black tracking-tighter ${tablePending ? 'text-red-400' : 'text-amber-400'}`}>
                        {group.label}
                      </span>
                      {!tablePending && group.calls.length > 0 && (
                        <Button 
                          variant="destructive" 
                          size="sm" 
                          onClick={() => setConfirmDismissAllModal(group.calls)}
                          className="text-white text-[10px] h-6 px-2 border-white/10 hover:bg-red-700 shadow-md shadow-red-500/20"
                        >
                          Dismiss All
                        </Button>
                      )}
                    </div>
                    
                    <div className="px-1.5 pb-1.5 space-y-1.5 relative z-10">
                      <AnimatePresence>
                        {group.calls.map(call => {
                          const isPending = call.status === 'pending';
                          return (
                            <motion.div 
                              key={call.id} 
                              initial={{ opacity: 0, x: -10 }}
                              animate={{ opacity: 1, x: 0 }}
                              exit={{ opacity: 0, x: 10 }}
                              className="bg-slate-950/50 rounded-lg py-1 px-1.5 flex items-center justify-between gap-1.5 border border-white/5"
                            >
                              <div className="flex items-center gap-2 flex-1 min-w-0">
                                <div className="w-7 h-7 rounded-full bg-slate-800/80 flex items-center justify-center shrink-0 border border-white/5 hidden sm:flex">
                                  <span className="text-sm drop-shadow-md">
                                    {call.icon_name === 'bell' ? '🔔' : 
                                     call.icon_name === 'receipt' ? '🧾' : 
                                     call.icon_name === 'gamepad' ? '🎮' : 
                                     call.icon_name === 'coffee' ? '☕' : 
                                     call.icon_name === 'flame' ? '🔥' : 
                                     call.icon_name === 'water' ? '🧊' : '🔘'}
                                  </span>
                                </div>
                                <div className="flex-1 min-w-0 pr-1">
                                  <h3 className="text-[13px] sm:text-sm font-bold text-white leading-tight whitespace-normal break-words">
                                    {actionButtons[call.button_key] 
                                      ? (lang === 'ar' ? actionButtons[call.button_key].label_ar : actionButtons[call.button_key].label_en) 
                                      : call.action_label}
                                  </h3>
                                  <div className="flex items-center gap-1 mt-0.5 text-[10px] font-medium text-slate-400 whitespace-nowrap">
                                    <Clock className="w-3 h-3" />
                                    <span>{new Date(call.created_at).toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'})}</span>
                                  </div>
                                </div>
                              </div>
                              
                              <div className="flex gap-1.5 shrink-0">
                                {isPending ? (
                                  <Button
                                    className="h-7 text-xs bg-gradient-to-r from-blue-600 to-indigo-600 hover:from-blue-500 hover:to-indigo-500 border-none text-white px-2 shadow-md shadow-blue-500/20 whitespace-nowrap flex-1 xl:flex-none"
                                    onClick={() => handleAcknowledgeCall(call.id)}
                                  >
                                    {t.acknowledge}
                                  </Button>
                                ) : (
                                  <Button
                                    variant="destructive"
                                    className="h-7 text-xs px-2 whitespace-nowrap text-slate-100 bg-slate-800/80 hover:bg-red-600 hover:text-white border-white/10 flex-1 xl:flex-none"
                                    onClick={() => handleDismissCall(call.id, call.created_at)}
                                  >
                                    <CheckCircle2 className="w-3 h-3 mr-1 inline" />
                                    {t.dismiss}
                                  </Button>
                                )}
                              </div>
                            </motion.div>
                          );
                        })}
                      </AnimatePresence>
                    </div>
                  </Card>
                </motion.div>
              )
            })}
            {calls.length === 0 && (
              <motion.div 
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                className="col-span-full flex flex-col items-center justify-center py-20 text-slate-500"
              >
                <div className="w-24 h-24 mb-6 rounded-full glass flex items-center justify-center">
                  <CheckCircle2 className="w-12 h-12 text-slate-400" />
                </div>
                <h3 className="text-2xl font-bold">{t.all_caught_up}</h3>
                <p className="mt-2 text-center max-w-sm">{t.no_pending_reqs}</p>
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      </div>

      {/* Right Column: Table Manager Grid */}
      <div className="w-full md:w-64 xl:w-72 shrink-0">
        <div className="glass p-4 rounded-2xl sticky top-4">
          <h2 className="text-base font-bold mb-1">{t.table_status}</h2>
          <p className="text-[10px] text-slate-400 mb-4 leading-relaxed">
            {t.table_status_desc}
          </p>

          <div className="grid grid-cols-3 sm:grid-cols-4 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-3 gap-2">
            {tables.map(table => {
              const hasPendingCalls = calls.some(c => c.table_id === table.id && c.status === 'pending');
              return (
              <button
                key={table.id}
                onClick={() => toggleTableOccupancy(table.id, table.is_occupied)}
                className={`p-2 rounded-lg text-center transition-all duration-300 border relative overflow-hidden ${
                  table.is_occupied 
                    ? hasPendingCalls 
                      ? 'bg-red-600/20 border-red-500/50 hover:bg-red-600/30 text-red-200 animate-pulse-slow' 
                      : 'bg-blue-600/20 border-blue-500/30 hover:bg-blue-600/30 text-blue-200' 
                    : 'bg-slate-800/50 border-white/5 hover:bg-slate-800 text-slate-500'
                }`}
                title={table.label}
              >
                {hasPendingCalls && (
                  <div className="absolute top-0 right-0 p-0.5 animate-bounce">
                    <AlertTriangle className="w-3 h-3 text-red-500" />
                  </div>
                )}
                <div className="font-bold text-xs truncate pr-3">{table.label.replace('Table', '').trim()}</div>
                <div className="text-[8px] uppercase font-bold tracking-wider mt-0.5">
                  {table.is_occupied ? `🟢` : `⚪`}
                </div>
              </button>
            )})}
          </div>
        </div>
      </div>
      
      {/* Dismiss All Confirmation Modal */}
      <AnimatePresence>
        {confirmDismissAllModal && (
          <div className="fixed inset-0 bg-black/80 backdrop-blur-sm flex items-center justify-center z-[100] p-4">
            <motion.div 
              initial={{ scale: 0.9, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              exit={{ scale: 0.9, opacity: 0 }}
              className="bg-slate-900 border border-red-500/30 p-8 rounded-3xl max-w-md w-full shadow-2xl"
            >
              <div className="w-16 h-16 bg-red-500/10 rounded-full flex items-center justify-center mb-6 mx-auto">
                <AlertTriangle className="w-8 h-8 text-red-500" />
              </div>
              <h2 className="text-2xl font-bold text-center mb-4 text-white">{t.dismiss_all_title}</h2>
              <p className="text-slate-400 text-center mb-8">
                {t.dismiss_all_desc?.replace('{count}', confirmDismissAllModal.length)}
              </p>
              <div className="flex gap-4">
                <Button 
                  variant="outline" 
                  className="flex-1 border-white/10 hover:bg-white/5 text-white"
                  onClick={() => setConfirmDismissAllModal(null)}
                >
                  {t.cancel}
                </Button>
                <Button 
                  variant="destructive" 
                  className="flex-1 bg-red-600 hover:bg-red-700 text-white"
                  onClick={handleDismissAllConfirmed}
                >
                  {t.yes_dismiss}
                </Button>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>

      {/* History Modal */}
      <AnimatePresence>
        {showHistory && (
          <div className="fixed inset-0 bg-slate-950/90 backdrop-blur-md flex items-center justify-center z-[200] p-4 md:p-10">
            <motion.div 
              initial={{ opacity: 0, y: 30 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: 30 }}
              className="bg-slate-900 border border-white/10 p-6 rounded-3xl w-full max-w-6xl max-h-[90vh] overflow-y-auto custom-scrollbar relative shadow-2xl"
            >
              <button 
                onClick={() => setShowHistory(false)}
                className="absolute top-6 right-6 p-2 bg-white/5 hover:bg-white/10 rounded-full text-slate-400 hover:text-white transition-colors"
                title="Close"
              >
                <X className="w-6 h-6" />
              </button>
              <div className="mt-8">
                <CallHistoryPanel venueId={venueId} />
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>
    </div>
  );
}
