import React, { useState, useEffect, useRef } from 'react'
import { Amplify } from 'aws-amplify'
import { generateClient } from 'aws-amplify/api'
import { submitConcept } from './services/api'
import './App.css'

// 1. Initialize Amplify with AppSync credentials
if (!import.meta.env.VITE_APPSYNC_GRAPHQL) {
  throw new Error(`Failed to fetch appsync endpoint`);
}

Amplify.configure({
  API: {
    GraphQL: {
      endpoint: import.meta.env.VITE_APPSYNC_GRAPHQL || '',
      region: 'us-east-1',
      defaultAuthMode: 'apiKey',
      apiKey: import.meta.env.VITE_APPSYNC_API_KEY || ''
    }
  }
})

const client = generateClient()

// GraphQL Response Data Types
interface JobStatusPayload {
  jobId: string
  status: 'queued' | 'running' | 'succeeded' | 'failed'
  videoUrl?: string
  error?: string
}

interface OnJobStatusChangedData {
  onJobStatusChanged: JobStatusPayload
}

const OnJobStatusChangedSubscription = /* GraphQL */ `
  subscription OnJobStatusChanged($jobId: ID!) {
    onJobStatusChanged(jobId: $jobId) {
      jobId
      status
      videoUrl
      error
    }
  }
`

function App() {
  const [prompt, setPrompt] = useState('')
  const [submittedPrompt, setSubmittedPrompt] = useState('')
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [message, setMessage] = useState('')
  const [videoUrl, setVideoUrl] = useState<string | null>(null)

  // Type-safe subscription ref for Amplify v6
  const subscriptionRef = useRef<{ unsubscribe: () => void } | null>(null)

  // Clean up subscription on component unmount
  useEffect(() => {
    return () => {
      if (subscriptionRef.current) {
        subscriptionRef.current.unsubscribe()
      }
    }
  }, [])

  const handleSubmit = async () => {
    if (!prompt.trim() || isSubmitting) return

    setIsSubmitting(true)
    setMessage('Submitting prompt...')
    setVideoUrl(null)

    try {
      const result = await submitConcept(prompt)
      const jobId = result.job_id

      setSubmittedPrompt(prompt.trim())
      setPrompt('')
      setMessage(`Video generation is in progress...Kindly take a coffee break for some minutes ˙✧˖°☕ ༘ ⋆｡ ˚ `)

      // 2. Pass generic type OnJobStatusChangedData directly into client.graphql()
      const subscriptionObservable = await client.graphql<OnJobStatusChangedData>({
        query: OnJobStatusChangedSubscription,
        variables: { jobId }
      })

      // Ensure response is an Observable with a .subscribe method
      if ('subscribe' in subscriptionObservable) {
        const sub = subscriptionObservable.subscribe({
          next: ({ data }) => {
            const payload = data?.onJobStatusChanged
            if (!payload) return

            if (payload.status === 'succeeded' && payload.videoUrl) {
              setVideoUrl(payload.videoUrl)
              setMessage('')
              setIsSubmitting(false)

              if (subscriptionRef.current) {
                subscriptionRef.current.unsubscribe()
                subscriptionRef.current = null
              }
            } else if (payload.status === 'failed') {
              setMessage(`✗ Generation failed: ${payload.error || 'Unknown error'}`)
              setIsSubmitting(false)

              if (subscriptionRef.current) {
                subscriptionRef.current.unsubscribe()
                subscriptionRef.current = null
              }
            }
          },
          error: (err: unknown) => {
            console.error('Subscription error:', err)
            setMessage('An error occured. Connection lost.')
            setIsSubmitting(false)
          }
        })

        subscriptionRef.current = sub
      }

    } catch (err) {
      setMessage(`✗ Error: ${(err as Error).message}`)
      setIsSubmitting(false)
    }
  }

  const handleKeyPress = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && e.ctrlKey && !isSubmitting) {
      handleSubmit()
    }
  }

  return (
    <>
      <section id="center">
        <div>
          <h1>Simple science animation</h1>
          <p>Enter your scientific question below</p>
        </div>
        <div className="prompt-container">
          <textarea
            className="prompt-input"
            placeholder="Enter your question here..."
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            onKeyDown={handleKeyPress}
            disabled={isSubmitting}
          ></textarea>
          <button
            type="button"
            className="submit-button"
            onClick={handleSubmit}
            disabled={isSubmitting || !prompt.trim()}
          >
            {isSubmitting ? 'Generating video...' : 'Submit'}
          </button>
        </div>

        {message && <p className="message">{message}</p>}

        {submittedPrompt && (
          <p className="submitted-prompt">{submittedPrompt}</p>
        )}

        {videoUrl && (
          <div className="video-container" style={{ marginTop: '20px' }}>
            <video
              controls
              width="100%"
              style={{ borderRadius: '8px', maxHeight: '450px' }}
            >
              <source src={videoUrl} type="video/mp4" />
              Your browser does not support HTML5 video.
            </video>
          </div>
        )}
      </section>
    </>
  )
}

export default App