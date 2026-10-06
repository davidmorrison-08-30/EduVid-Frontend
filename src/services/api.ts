import { API_GATEWAY_URL } from '../config';

export async function submitConcept(concept: string) {
  const response = await fetch(`${API_GATEWAY_URL}/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ concept }),
  });
  
  if (!response.ok) {
    throw new Error(`Failed: ${response.statusText}`);
  }
  
  return response.json();
}

export async function checkJobStatus(jobId: string) {
  const response = await fetch(`${API_GATEWAY_URL}/status/${jobId}`);
  
  if (!response.ok) {
    throw new Error(`Failed to fetch status`);
  }
  
  return response.json();
}