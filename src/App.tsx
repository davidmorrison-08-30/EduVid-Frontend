import { useState } from 'react'
import { submitConcept } from './services/api'
import './App.css'

function App() {
  const [prompt, setPrompt] = useState('')
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [message, setMessage] = useState('')

  const handleSubmit = async () => {
    if (!prompt.trim()) return
    setIsSubmitting(true)
    setMessage('')
    try {
      const result = await submitConcept(prompt)
      setMessage(`✓ Video generation started! Job ID: ${result.job_id}`)
      setPrompt('')
    } catch (err) {
      setMessage(`✗ Error: ${(err as Error).message}`)
    } finally {
      setIsSubmitting(false)
    }
  }

  const handleKeyPress = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter'&& !isSubmitting) {
      handleSubmit()
    }
  }

  return (
    <>
      <section id="center">
        <div>
          <h1>EduVid</h1>
          <p>Enter your prompt below</p>
        </div>
        <div className="prompt-container">
          <input
            type="text"
            className="prompt-input"
            placeholder="Enter your prompt here..."
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            onKeyDown={handleKeyPress}
          />
          <button
            type="button"
            className="submit-button"
            onClick={handleSubmit}
            disabled={isSubmitting}
          >
            {isSubmitting ? 'Submitting...' : 'Submit'}
          </button>
        </div>
        {message && <p className="message">{message}</p>}
      </section>
    </>
  )
}

export default App
