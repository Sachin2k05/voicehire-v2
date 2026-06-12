/* ─────────────────────────────────────────────
   login.js  —  VoiceHire OTP Login
   Handles:
     • Voice phone number input
     • OTP send via backend (Twilio SMS)
     • Web OTP API autofill (Chrome Android)
     • 6-box OTP keyboard navigation
     • Resend countdown timer
     • JWT token + profile load on success
     • Guest skip
   ───────────────────────────────────────────── */

/* ══════════════════════════════════════════════
   STATE
══════════════════════════════════════════════ */
let _loginPhone       = ''   // normalised +91XXXXXXXXXX
let _resendTimer      = null
let _webOtpController = null
let _voiceRecog       = null

/* ══════════════════════════════════════════════
   SHOW / HIDE
══════════════════════════════════════════════ */
function showLoginScreen() {
  const s = document.getElementById('login-screen')
  if (s) s.classList.remove('hidden', 'fade-out')

  // Auto-restore if token already saved
  const saved = localStorage.getItem('vh_token')
  if (saved) {
    BackendService.token  = saved
    BackendService.userId = localStorage.getItem('vh_userId')
    _autoRestoreSession()
  }
}

function hideLoginScreen(cb) {
  const s = document.getElementById('login-screen')
  if (!s) { if (cb) cb(); return }
  s.classList.add('fade-out')
  setTimeout(function () { s.classList.add('hidden'); if (cb) cb() }, 400)
}

function proceedToLanguage() {
  hideLoginScreen(function () {
    showLanguageScreen()
    setTimeout(startVoiceLanguageSelection, 800)
  })
}

/* ══════════════════════════════════════════════
   AUTO-RESTORE (returning user with saved token)
══════════════════════════════════════════════ */
async function _autoRestoreSession() {
  try {
    const res  = await fetch(BACKEND_URL + '/api/profile', {
      headers: { Authorization: 'Bearer ' + BackendService.token }
    })
    const data = await res.json()
    if (data.success && data.profile) {
      _applyProfile(data.profile)
      console.log('[Login] Session restored — profile loaded')
    }
  } catch (e) {
    console.warn('[Login] Auto-restore failed:', e.message)
    // Token may be expired — clear it so user can log in fresh
    localStorage.removeItem('vh_token')
    localStorage.removeItem('vh_userId')
    BackendService.token  = null
    BackendService.userId = null
  }
}

/* ══════════════════════════════════════════════
   PHONE NORMALISATION
   "9876543210"    → "+919876543210"
   "09876543210"   → "+919876543210"
   "+919876543210" → "+919876543210"
══════════════════════════════════════════════ */
function _normalisePhone(raw) {
  const digits = (raw || '').replace(/\D/g, '')
  if (digits.length === 10)                       return '+91' + digits
  if (digits.length === 11 && digits[0] === '0') return '+91' + digits.slice(1)
  if (digits.length === 12 && digits.startsWith('91')) return '+' + digits
  if (digits.length === 13 && (raw || '').startsWith('+')) return raw.trim()
  return null
}

/* ══════════════════════════════════════════════
   STEP 1 — SEND OTP
══════════════════════════════════════════════ */
async function sendOtp() {
  const raw   = (document.getElementById('login-phone').value || '').trim()
  const errEl = document.getElementById('login-phone-error')
  errEl.textContent = ''

  const phone = _normalisePhone(raw)
  if (!phone) {
    errEl.textContent = 'Please enter a valid 10-digit Indian mobile number.'
    document.getElementById('login-phone').focus()
    return
  }

  _loginPhone = phone

  const btn = document.getElementById('login-send-btn')
  btn.disabled = true
  btn.innerHTML = '<span class="login-spinner"></span> Sending…'

  try {
    const res  = await fetch(BACKEND_URL + '/api/otp/send', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ phone })
    })
    const data = await res.json()

    if (data.success) {
      _showOtpStep()
      _startResendTimer(30)
      _startWebOtpApi()        // Chrome Android autofill
    } else {
      errEl.textContent = data.error || 'Failed to send OTP. Please try again.'
    }

  } catch (err) {
    errEl.textContent = 'Connection error. Check your internet and try again.'
    console.error('[Login] sendOtp error:', err)
  }

  btn.disabled = false
  btn.textContent = 'Send OTP →'
}

/* ══════════════════════════════════════════════
   SWITCH STEPS
══════════════════════════════════════════════ */
function _showOtpStep() {
  document.getElementById('login-step-phone').style.display = 'none'
  document.getElementById('login-step-otp').style.display   = ''
  // Show which number OTP was sent to
  const hint = document.getElementById('otp-hint-text')
  if (hint) hint.textContent = 'Enter the 6-digit code sent to ' + _loginPhone
  // Focus first box
  setTimeout(function () {
    const box = document.getElementById('otp-0')
    if (box) box.focus()
  }, 200)
}

function backToPhone() {
  // Cancel Web OTP listener
  if (_webOtpController) { _webOtpController.abort(); _webOtpController = null }
  clearInterval(_resendTimer)
  _clearOtpBoxes()
  document.getElementById('login-step-otp').style.display   = 'none'
  document.getElementById('login-step-phone').style.display = ''
  document.getElementById('login-otp-error').textContent    = ''
  document.getElementById('login-phone').focus()
}

/* ══════════════════════════════════════════════
   OTP BOX KEYBOARD NAVIGATION
══════════════════════════════════════════════ */
function otpInput(e, index) {
  const val = e.target.value.replace(/\D/g, '')
  e.target.value = val

  if (val.length === 1) {
    e.target.classList.add('filled')
    // Move to next box
    if (index < 5) {
      const next = document.getElementById('otp-' + (index + 1))
      if (next) next.focus()
    }
  } else {
    e.target.classList.remove('filled')
  }

  _checkOtpComplete()
}

function otpKeydown(e, index) {
  if (e.key === 'Backspace' && !e.target.value && index > 0) {
    // Move to previous box on backspace when empty
    const prev = document.getElementById('otp-' + (index - 1))
    if (prev) { prev.value = ''; prev.classList.remove('filled'); prev.focus() }
  }
  if (e.key === 'Enter') verifyOtp()
  // Handle paste across all boxes
  if (e.key === 'v' && (e.ctrlKey || e.metaKey)) {
    e.preventDefault()
    navigator.clipboard.readText().then(_pasteOtp).catch(function(){})
  }
}

function _pasteOtp(text) {
  const digits = (text || '').replace(/\D/g, '').slice(0, 6)
  if (digits.length < 4) return
  digits.split('').forEach(function (d, i) {
    const box = document.getElementById('otp-' + i)
    if (box) { box.value = d; box.classList.add('filled') }
  })
  _checkOtpComplete()
  const lastBox = document.getElementById('otp-' + (digits.length - 1))
  if (lastBox) lastBox.focus()
}

function _checkOtpComplete() {
  const code = _getOtpCode()
  const verifyBtn = document.getElementById('otp-verify-btn')
  if (verifyBtn) verifyBtn.disabled = code.length < 6
  // Auto-verify when all 6 digits entered
  if (code.length === 6) setTimeout(verifyOtp, 300)
}

function _getOtpCode() {
  let code = ''
  for (let i = 0; i < 6; i++) {
    const box = document.getElementById('otp-' + i)
    if (box) code += (box.value || '')
  }
  return code
}

function _clearOtpBoxes() {
  for (let i = 0; i < 6; i++) {
    const box = document.getElementById('otp-' + i)
    if (box) { box.value = ''; box.classList.remove('filled', 'shake') }
  }
  const btn = document.getElementById('otp-verify-btn')
  if (btn) btn.disabled = true
}

function _shakeOtpBoxes() {
  for (let i = 0; i < 6; i++) {
    const box = document.getElementById('otp-' + i)
    if (box) {
      box.classList.remove('shake')
      void box.offsetWidth // reflow to restart animation
      box.classList.add('shake')
    }
  }
  setTimeout(function () {
    for (let i = 0; i < 6; i++) {
      const box = document.getElementById('otp-' + i)
      if (box) box.classList.remove('shake')
    }
  }, 400)
}

/* ══════════════════════════════════════════════
   WEB OTP API — Chrome Android autofill
   The browser intercepts the SMS and fills
   the code automatically — user does nothing.
══════════════════════════════════════════════ */
function _startWebOtpApi() {
  if (!('OTPCredential' in window)) return  // not supported
  const autoLabel = document.getElementById('otp-auto-label')
  if (autoLabel) autoLabel.style.display = ''

  _webOtpController = new AbortController()

  navigator.credentials.get({
    otp:    { transport: ['sms'] },
    signal: _webOtpController.signal
  }).then(function (otpCredential) {
    if (!otpCredential) return
    const code = otpCredential.code
    console.log('[WebOTP] Autofilled:', code)
    if (autoLabel) autoLabel.style.display = 'none'
    _pasteOtp(code)
    // verifyOtp is called automatically by _checkOtpComplete
  }).catch(function (err) {
    if (err.name !== 'AbortError') {
      console.warn('[WebOTP] Error:', err.message)
    }
    if (autoLabel) autoLabel.style.display = 'none'
  })
}

/* ══════════════════════════════════════════════
   STEP 2 — VERIFY OTP
══════════════════════════════════════════════ */
async function verifyOtp() {
  const code  = _getOtpCode()
  const errEl = document.getElementById('login-otp-error')
  errEl.textContent = ''

  if (code.length < 6) {
    errEl.textContent = 'Please enter all 6 digits.'
    return
  }

  // Cancel Web OTP listener — no longer needed
  if (_webOtpController) { _webOtpController.abort(); _webOtpController = null }

  const btn = document.getElementById('otp-verify-btn')
  btn.disabled = true
  btn.innerHTML = '<span class="login-spinner"></span> Verifying…'

  try {
    const res  = await fetch(BACKEND_URL + '/api/otp/verify', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ phone: _loginPhone, otp: code })
    })
    const data = await res.json()

    if (data.success) {
      // Save token + userId
      BackendService.token  = data.token
      BackendService.userId = data.user.id
      localStorage.setItem('vh_token',  data.token)
      localStorage.setItem('vh_userId', data.user.id)

      // Phone saved into profile for later use in resume
      if (State && State.profile) {
        State.profile.phone = _loginPhone
      }

      // Pre-load saved profile for returning users
      if (!data.isNew && data.profile) {
        _applyProfile(data.profile)
        console.log('[Login] Returning user — profile loaded')
      } else {
        console.log('[Login] New user — starting fresh profile')
      }

      clearInterval(_resendTimer)
      proceedToLanguage()

    } else {
      errEl.textContent = data.error || 'Incorrect code. Please try again.'
      _shakeOtpBoxes()
      _clearOtpBoxes()
      document.getElementById('otp-0').focus()
    }

  } catch (err) {
    errEl.textContent = 'Connection error. Please try again.'
    console.error('[Login] verifyOtp error:', err)
  }

  btn.disabled = false
  btn.textContent = 'Verify →'
}

/* ══════════════════════════════════════════════
   RESEND OTP — with countdown timer
══════════════════════════════════════════════ */
function _startResendTimer(seconds) {
  clearInterval(_resendTimer)
  const timerEl  = document.getElementById('otp-timer')
  const resendBtn = document.getElementById('otp-resend-btn')
  let remaining = seconds

  if (resendBtn) resendBtn.disabled = true

  _resendTimer = setInterval(function () {
    remaining--
    if (timerEl) timerEl.textContent = remaining > 0 ? 'Resend in ' + remaining + 's' : ''
    if (remaining <= 0) {
      clearInterval(_resendTimer)
      if (resendBtn) resendBtn.disabled = false
      if (timerEl)   timerEl.textContent = ''
    }
  }, 1000)
}

async function resendOtp() {
  const errEl = document.getElementById('login-otp-error')
  errEl.textContent = ''

  const btn = document.getElementById('otp-resend-btn')
  btn.disabled = true
  btn.textContent = 'Sending…'

  try {
    const res  = await fetch(BACKEND_URL + '/api/otp/send', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ phone: _loginPhone })
    })
    const data = await res.json()

    if (data.success) {
      _clearOtpBoxes()
      _startResendTimer(60)   // longer wait on second send
      _startWebOtpApi()
      document.getElementById('otp-0').focus()
    } else {
      errEl.textContent = data.error || 'Failed to resend. Try again.'
      btn.disabled = false
    }
  } catch (err) {
    errEl.textContent = 'Connection error.'
    btn.disabled = false
  }

  btn.textContent = 'Resend OTP'
}

/* ══════════════════════════════════════════════
   VOICE INPUT — user speaks their phone number
══════════════════════════════════════════════ */
function startVoiceLogin() {
  const btn    = document.getElementById('login-voice-btn')
  const status = document.getElementById('login-voice-status')

  // If already listening — stop
  if (_voiceRecog) {
    _voiceRecog.stop()
    _voiceRecog = null
    btn.classList.remove('listening')
    btn.querySelector('.login-voice-label').textContent = 'Speak your phone number'
    if (status) status.textContent = ''
    return
  }

  if (!('webkitSpeechRecognition' in window) &&
      !('SpeechRecognition' in window)) {
    if (status) status.textContent = 'Voice not supported on this browser'
    return
  }

  // Speak a prompt first, then listen
  const SpeechSynthUtter = new SpeechSynthesisUtterance(
    'Say your 10-digit phone number clearly, one digit at a time.'
  )
  SpeechSynthUtter.lang = 'en-IN'
  SpeechSynthUtter.rate = 0.9
  window.speechSynthesis.speak(SpeechSynthUtter)

  SpeechSynthUtter.onend = function () {
    _startVoiceRecognition(btn, status)
  }
}

function _startVoiceRecognition(btn, status) {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition
  _voiceRecog = new SR()
  _voiceRecog.lang        = 'en-IN'
  _voiceRecog.continuous  = false
  _voiceRecog.interimResults = true

  btn.classList.add('listening')
  btn.querySelector('.login-voice-label').textContent = 'Listening… tap to stop'
  if (status) status.textContent = '🎤 Speak now…'

  _voiceRecog.onresult = function (e) {
    const transcript = Array.from(e.results)
      .map(function (r) { return r[0].transcript }).join(' ')
    // Show live digits
    const digits = transcript.replace(/\D/g, '')
    if (status) status.textContent = digits || transcript
    if (e.results[0].isFinal) {
      // Extract all digits spoken
      const phoneDigits = transcript.replace(/\D/g, '').slice(0, 10)
      const input = document.getElementById('login-phone')
      if (input) input.value = phoneDigits
      if (status) status.textContent = phoneDigits.length === 10
        ? '✓ ' + phoneDigits : 'Heard: ' + phoneDigits + ' (need 10 digits)'
    }
  }

  _voiceRecog.onend = function () {
    _voiceRecog = null
    btn.classList.remove('listening')
    btn.querySelector('.login-voice-label').textContent = 'Speak your phone number'

    // Auto-send if 10 digits captured
    const val = (document.getElementById('login-phone').value || '').replace(/\D/g,'')
    if (val.length === 10) {
      setTimeout(sendOtp, 400)
    }
  }

  _voiceRecog.onerror = function (e) {
    if (status) status.textContent = 'Could not hear clearly. Please try again.'
    btn.classList.remove('listening')
    btn.querySelector('.login-voice-label').textContent = 'Speak your phone number'
    _voiceRecog = null
  }

  _voiceRecog.start()
}

/* ══════════════════════════════════════════════
   GUEST SKIP
══════════════════════════════════════════════ */
function skipLogin() {
  console.log('[Login] Guest mode')
  localStorage.removeItem('vh_token')
  localStorage.removeItem('vh_userId')
  BackendService.token  = null
  BackendService.userId = null
  if (_webOtpController) { _webOtpController.abort(); _webOtpController = null }
  proceedToLanguage()
}

/* ══════════════════════════════════════════════
   APPLY PROFILE DATA (returning user)
══════════════════════════════════════════════ */
function _applyProfile(p) {
  if (!p) return
  const map = {
    name: 'name', skills: 'skills', experience: 'experience',
    location: 'location', job_type: 'jobType', salary: 'salary',
    education: 'education', languages: 'languages',
    email: 'email', phone: 'phone', linkedin: 'linkedIn',
    current_company: 'currentCompany', notice_period: 'noticePeriod',
    voice_pitch_url: 'voicePitchUrl'
  }
  Object.keys(map).forEach(function (dbKey) {
    const stateKey = map[dbKey]
    if (p[dbKey]) {
      if (State && State.profile) State.profile[stateKey] = p[dbKey]
      if (typeof updateProfileField === 'function') {
        updateProfileField(stateKey, p[dbKey])
      }
    }
  })
}
