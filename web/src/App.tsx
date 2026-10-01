import { createHashRouter, Navigate, RouterProvider } from 'react-router-dom'
import { AppShell } from './shell/AppShell'
import { homeFor, SessionProvider, useSession } from './shell/session'
import { ToastProvider } from './components/Toasts'
import { MyWork } from './pages/MyWork'
import { TeamBoard } from './pages/TeamBoard'
import { Insights } from './pages/Insights'
import { Intake } from './pages/Intake'
import { LifeIntake } from './pages/LifeIntake'
import { ClaimWorkspace } from './claim/ClaimWorkspace'
import { Portal } from './portal/Portal'

function Home() {
  const { user } = useSession()
  return <Navigate to={homeFor(user)} replace />
}

// Hash routing so the built app runs from any static host or file share without server rewrites.
const router = createHashRouter([
  {
    element: <AppShell />,
    children: [
      { index: true, element: <Home /> },
      { path: 'work', element: <MyWork /> },
      { path: 'team', element: <TeamBoard /> },
      { path: 'insights', element: <Insights /> },
      { path: 'intake', element: <Intake /> },
      { path: 'intake/life', element: <LifeIntake /> },
      { path: 'claims/:claimId', element: <Navigate to="overview" replace /> },
      { path: 'claims/:claimId/:section', element: <ClaimWorkspace /> },
      { path: 'claims/:claimId/:section/:target', element: <ClaimWorkspace /> },
      { path: '*', element: <Home /> },
    ],
  },
  { path: 'portal/*', element: <Portal /> },
])

export function App() {
  return (
    <SessionProvider>
      <ToastProvider>
        <RouterProvider router={router} />
      </ToastProvider>
    </SessionProvider>
  )
}
