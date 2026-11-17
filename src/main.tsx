import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'

// Surface CSP violations in the console (and Android logcat via Tauri/Console).
document.addEventListener('securitypolicyviolation', (e) => {
  console.warn(`[CSP] blocked ${e.blockedURI || '(inline)'} by ${e.violatedDirective}`)
})

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
