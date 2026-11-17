import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'

// Surface CSP violations in the console (and Android logcat via Tauri/Console).
document.addEventListener('securitypolicyviolation', (e) => {
  console.warn(`[CSP] blocked ${e.blockedURI || '(inline)'} by ${e.violatedDirective}`)
})

const rootElement = document.getElementById('root')
if (!rootElement) throw new Error('index.html is missing the #root element')

createRoot(rootElement).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
