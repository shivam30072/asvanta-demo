import { createContext, useCallback, useContext, useMemo, useReducer, useRef } from 'react'
import { CENTRE, NOTIFICATIONS, SEED_STUDIES, USERS } from './data/seed'

const StoreCtx = createContext(null)

const initialState = () => ({
  authed: false,
  role: 'staff',
  centre: CENTRE,
  route: { name: 'dashboard', params: {} },
  studies: SEED_STUDIES.map((s) => ({ ...s })),
  notifications: NOTIFICATIONS.map((n) => ({ ...n })),
  toasts: [],
  patientLinkStudyId: 'STD-24814', // which study the patient portal opens
})

let toastSeq = 0

function reducer(state, action) {
  switch (action.type) {
    case 'login':
      return { ...state, authed: true, role: action.role, route: { name: action.role === 'radiologist' ? 'worklist' : 'dashboard', params: {} } }

    case 'logout':
      return { ...initialState(), studies: state.studies, notifications: state.notifications }

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

  const api = useMemo(() => {
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

    return {
      state,
      dispatch,
      toast,
      navigate,
      pushEvent,
      user: USERS[state.role],
      login: (role) => dispatch({ type: 'login', role }),
      logout: () => dispatch({ type: 'logout' }),
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

  return <StoreCtx.Provider value={api}>{children}</StoreCtx.Provider>
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
