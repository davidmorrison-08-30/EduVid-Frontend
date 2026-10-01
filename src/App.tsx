import { useState } from 'react'
import './App.css'

function App() {
  const [prompt, setPrompt] = useState('')

  const handleSubmit = () => {
    console.log('Prompt submitted:', prompt)
    // TODO: Add action to perform with the prompt
  }

  const handleKeyPress = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
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
          >
            Submit
          </button>
        </div>
      </section>
    </>
  )
}

export default App
