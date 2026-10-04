import { createContext, useCallback, useContext, useEffect, useMemo, useReducer, useRef } from 'react'
import { CENTRE, NOTIFICATIONS, SEED_STUDIES, USERS } from './data/seed'
import { api, isLive, getToken, setToken } from './live/api'

const StoreCtx = createContext(null)

const initialState = () => ({
  live: isLive,
  authed: false,
  role: 'staff',
  liveUser: null,
  centre: CENTRE,
  route: { name: 'dashboard', params: {} },
  // live mode starts empty and fills from the gateway; the demo starts from seed data
  studies: isLive ? [] : SEED_STUDIES.map((s) => ({ ...s })),
  notifications: isLive ? [] : NOTIFICATIONS.map((n) => ({ ...n })),
  toasts: [],
  patientLinkStudyId: 'STD-24814', // which study the patient portal opens
})

let toastSeq = 0

/**
 * Merge a study from the gateway over the local copy. The series list, an
 * in-progress (unapproved) CAC review and CPR verifications made in this session
 * are local working state and survive a refresh.
 */
function mergeStudy(local, server) {
  if (!local) return { ...server, cac: toLocalCac(server.cac) }
  const keepCac = local.cac?.review && local.cac.review.status !== 'approved' ? local.cac : toLocalCac(server.cac) || local.cac
  return { ...server, seriesList: server.seriesList || local.seriesList, cac: keepCac, cpr: { ...(server.cpr || {}), ...(local.cpr || {}) } }
}

/** The gateway stores the approved CAC record; the UI keeps { seriesId, review }. */
function toLocalCac(c) {
  if (!c) return null
  if (c.review) return { seriesId: c.seriesId, review: c.review }
  if (c.approved) {
    const a = c.approved
    return {
      seriesId: c.seriesId,
      review: {
        status: 'approved',
        approved: a,
        summaryOnly: true,
        lesions: [],
        excluded: [],
        removed: [],
        audit: [{ at: a.approvedAt, user: a.approvedBy, action: 'Approved final score', detail: `${Math.round(a.totals.total)}`, delta: 0 }],
        algorithm: { totals: { total: a.algorithmTotal }, kind: a.kind, engineVersion: a.engineVersion },
      },
    }
  }
  return null
}

function reducer(state, action) {
  switch (action.type) {
    case 'login':
      return {
        ...state,
        authed: true,
        role: action.role,
        liveUser: action.user || null,
        route: { name: action.role === 'radiologist' ? 'worklist' : 'dashboard', params: {} },
      }

    case 'logout':
      return { ...initialState(), studies: state.live ? [] : state.studies, notifications: state.live ? [] : state.notifications }

    case 'set-studies': {
      // server copies win, except working state that only lives in this browser
      const prev = new Map(state.studies.map((s) => [s.id, s]))
      return { ...state, studies: action.studies.map((s) => mergeStudy(prev.get(s.id), s)) }
    }

    case 'put-study': {
      const exists = state.studies.some((s) => s.id === action.study.id)
      const studies = exists
        ? state.studies.map((s) => (s.id === action.study.id ? mergeStudy(s, action.study) : s))
        : [action.study, ...state.studies]
      return { ...state, studies }
    }

    case 'switch-role': {
      const home = action.role === 'radiologist' ? 'worklist' : action.role === 'patient' ? 'portal' : 'dashboard'
      return { ...state, role: action.role, authed: true, route: { name: home, params: {} } }
    }

    case 'navigate':
      return { ...state, route: { name: action.name, params: action.params || {} } }

    case 'add-study':
      return { ...state, studies: [action.study, ...state.studies] }

    case 'update-study':
      return {
        ...state,
        studies: state.studies.map((s) => (s.id === action.id ? action.updater(s) : s)),
      }

    case 'notify':
      return { ...state, notifications: [action.notification, ...state.notifications] }

    case 'read-notifications':
      return { ...state, notifications: state.notifications.map((n) => ({ ...n, unread: false })) }

    case 'toast':
      return { ...state, toasts: [...state.toasts, action.toast] }

    case 'dismiss-toast':
      return { ...state, toasts: state.toasts.filter((t) => t.id !== action.id) }

    case 'set-patient-link':
      return { ...state, patientLinkStudyId: action.id }

    case 'reset':
      return initialState()

    default:
      return state
  }
}

export function StoreProvider({ children }) {
  const [state, dispatch] = useReducer(reducer, undefined, initialState)
  const timers = useRef([])

  const toast = useCallback((text, kind = 'success', sub = '') => {
    const id = `t_${++toastSeq}`
    dispatch({ type: 'toast', toast: { id, text, kind, sub } })
    const h = setTimeout(() => dispatch({ type: 'dismiss-toast', id }), 4200)
    timers.current.push(h)
  }, [])

  const storeApi = useMemo(() => {
    const navigate = (name, params) => dispatch({ type: 'navigate', name, params })

    const pushEvent = (studyId, text, kind, actor) =>
      dispatch({
        type: 'update-study',
        id: studyId,
        updater: (s) => ({
          ...s,
          timeline: [...s.timeline, { id: `ev_${s.timeline.length}_${Date.now()}`, at: new Date().toISOString(), actor, text, kind }],
        }),
      })

    /* ------------------------------------------------ gateway (live mode) */

    const loadStudies = async () => {
      const studies = await api('/studies')
      dispatch({ type: 'set-studies', studies })
    }
    const refreshStudy = async (id) => {
      const study = await api(`/studies/${id}`)
      dispatch({ type: 'put-study', study })
      return study
    }
    const loadSeries = async (id) => {
      const seriesList = await api(`/studies/${id}/series`)
      dispatch({ type: 'update-study', id, updater: (s) => ({ ...s, seriesList }) })
    }
    const liveLogin = async (email, password) => {
      const { token, user } = await api('/auth/login', { method: 'POST', body: { email, password } })
      setToken(token)
      dispatch({ type: 'login', role: user.role, user })
      return user
    }

    const livePushEvent = (studyId, text, kind, actor) => {
      pushEvent(studyId, text, kind, actor)
      api(`/studies/${studyId}/events`, { method: 'POST', body: { text, kind } }).catch((e) => toast('Could not record event', 'error', e.message))
    }

    return {
      state,
      dispatch,
      toast,
      navigate,
      pushEvent: state.live ? livePushEvent : pushEvent,
      user: state.liveUser || USERS[state.role],
      live: state.live,
      loadStudies,
      refreshStudy,
      loadSeries,
      liveLogin,
      login: (role) => dispatch({ type: 'login', role }),
      logout: () => {
        if (state.live) {
          setToken(null)
        }
        dispatch({ type: 'logout' })
      },
      switchRole: (role) => dispatch({ type: 'switch-role', role }),
      reset: () => dispatch({ type: 'reset' }),
      addStudy: (study) => dispatch({ type: 'add-study', study }),
      updateStudy: (id, updater) => dispatch({ type: 'update-study', id, updater }),
      notify: (notification) => dispatch({ type: 'notify', notification: { id: `n_${Date.now()}`, at: new Date().toISOString(), unread: true, ...notification } }),
      readNotifications: () => dispatch({ type: 'read-notifications' }),
      setPatientLink: (id) => dispatch({ type: 'set-patient-link', id }),
      getStudy: (id) => state.studies.find((s) => s.id === id),
    }
  }, [state, toast])

  // live mode: resume a session, then keep the study list fresh so new scans appear
  useEffect(() => {
    if (!isLive || state.authed || !getToken()) return
    api('/auth/me')
      .then((user) => dispatch({ type: 'login', role: user.role, user }))
      .catch(() => setToken(null))
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!isLive || !state.authed) return
    let stop = false
    const pull = () => storeApi.loadStudies().catch((e) => !stop && e.status === 401 && storeApi.logout())
    pull()
    const h = setInterval(pull, 10000)
    return () => {
      stop = true
      clearInterval(h)
    }
  }, [state.authed]) // eslint-disable-line react-hooks/exhaustive-deps

  return <StoreCtx.Provider value={storeApi}>{children}</StoreCtx.Provider>
}

export const useStore = () => {
  const ctx = useContext(StoreCtx)
  if (!ctx) throw new Error('useStore must be used inside StoreProvider')
  return ctx
}

export const STATUS = {
  draft: { label: 'Draft', cls: 'bg-slate-100 text-slate-600', dot: 'bg-slate-400' },
  uploading: { label: 'Uploading', cls: 'bg-amber-50 text-amber-700', dot: 'bg-amber-500' },
  uploaded: { label: 'Uploaded', cls: 'bg-sky-50 text-sky-700', dot: 'bg-sky-500' },
  reporting: { label: 'Reporting', cls: 'bg-violet-50 text-violet-700', dot: 'bg-violet-500' },
  // signed by the radiologist, but not yet released to the patient by the centre
  ready: { label: 'Signed · to publish', cls: 'bg-emerald-50 text-emerald-700', dot: 'bg-emerald-500' },
  shared: { label: 'Sent to patient', cls: 'bg-brand-50 text-brand-700', dot: 'bg-brand-500' },
}
