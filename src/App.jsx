import { StoreProvider, useStore } from './store'
import { Toasts } from './components/ui'
import Login from './screens/Login'
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

function Router() {
  const { state, dispatch } = useStore()

  const screen = () => {
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
