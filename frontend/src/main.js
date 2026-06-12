import { createApp } from 'vue'
import axios from 'axios'
import App from './App.vue'

// Fetch a CSRF token once on startup and attach it to every mutating request
async function initCsrf() {
  try {
    const { data } = await axios.get('/csrf-token', { withCredentials: true })
    axios.defaults.headers.common['x-csrf-token'] = data.csrfToken
  } catch {
    // Non-fatal in dev environments without CSRF middleware
  }
}

initCsrf().then(() => createApp(App).mount('#app'))
