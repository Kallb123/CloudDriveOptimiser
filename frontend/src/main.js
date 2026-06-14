import { createApp } from 'vue'
import axios from 'axios'
import App from './App.vue'

axios.defaults.withCredentials = true

async function fetchCsrfToken() {
  const { data } = await axios.get('/csrf-token')
  if (!data?.csrfToken) {
    throw new Error('CSRF token missing from /csrf-token response')
  }
  axios.defaults.headers.common['x-csrf-token'] = data.csrfToken
}

async function ensureCsrfToken() {
  if (!axios.defaults.headers.common['x-csrf-token']) {
    await fetchCsrfToken()
  }
}

axios.interceptors.request.use(
  async (config) => {
    const method = (config.method || 'get').toLowerCase()
    if (['post', 'put', 'patch', 'delete'].includes(method)) {
      await ensureCsrfToken()
    }
    return config
  },
  (error) => Promise.reject(error)
)

async function initCsrf() {
  try {
    await ensureCsrfToken()
  } catch (error) {
    console.warn(
      'Unable to fetch CSRF token on startup; will retry before mutating requests.',
      error?.message || error
    )
  }
}

initCsrf().then(() => createApp(App).mount('#app'))
