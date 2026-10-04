import { StoreProvider, useStore } from './store'
import { Toasts } from './components/ui'
import Login from './screens/Login'
import Scanners from './screens/Scanners'
import ShareLink from './screens/ShareLink'
import { useEffect, useState } from 'react'
import Dashboard from './screens/Dashboard'
import NewStudy from './screens/NewStudy'
import UploadScreen from './screens/Upload'
import Studies from './screens/Studies'
import StudyDetail from './screens/StudyDetail'
import Worklist from './screens/Worklist'
import ReportEditor from './screens/ReportEditor'
import Deliveries from './screens/Deliveries'
import Viewer from './screens/Viewer'
import PatientPortal from './screens/PatientPortal'

const SCREENS = {
  scanners: Scanners,
  dashboard: Dashboard,
  'new-study': NewStudy,
  upload: UploadScreen,
  studies: Studies,
  study: StudyDetail,
  worklist: Worklist,
  report: ReportEditor,
  deliveries: Deliveries,
  viewer: Viewer,
  portal: PatientPortal,
}

/** `#/s/<token>` is a share link: public, opened from an SMS, no sign-in. */
const shareToken = () => {
  const m = /^#\/s\/([A-Za-z0-9_-]+)/.exec(window.location.hash)
  return m ? m[1] : null
}

function Router() {
  const { state, dispatch } = useStore()
  const [hashToken, setHashToken] = useState(shareToken)

  useEffect(() => {
    const on = () => setHashToken(shareToken())
    window.addEventListener('hashchange', on)
    return () => window.removeEventListener('hashchange', on)
  }, [])

  const screen = () => {
    if (hashToken) return <ShareLink token={hashToken} />
    if (state.route.name === 'share-link') return <ShareLink token={state.route.params.token} />
    if (!state.authed) return <Login />
    if (state.role === 'patient') return <PatientPortal />
    const Screen = SCREENS[state.route.name] || Dashboard
    return <Screen />
  }

  return (
    <>
      {screen()}
      <Toasts toasts={state.toasts} onDismiss={(id) => dispatch({ type: 'dismiss-toast', id })} />
    </>
  )
}

export default function App() {
  return (
    <StoreProvider>
      <Router />
    </StoreProvider>
  )
}
