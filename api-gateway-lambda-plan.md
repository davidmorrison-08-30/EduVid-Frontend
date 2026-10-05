# Alternative Plan: API Gateway + Lambda Approach

This approach decouples the frontend from the EduVid Fargate service by introducing AWS Lambda as an intermediary HTTP API layer. The frontend calls API Gateway → Lambda → EduVid Fargate (or internal service).

---

## Architecture Overview

```
┌─────────────┐
│   Frontend  │ (React/Vite on nginx in Fargate)
│  Port 3000  │
└──────┬──────┘
       │ HTTPS
       ↓
┌──────────────────────────────────────┐
│  AWS API Gateway                     │
│  POST /generate                      │
│  GET  /status/{job_id}               │
└──────┬───────────────────────────────┘
       │
       ↓
┌──────────────────────────────────────┐
│  AWS Lambda (Python 3.12)            │
│  ├─ generate_handler                 │
│  └─ status_handler                   │
└──────┬───────────────────────────────┘
       │ (ALB DNS or internal service discovery)
       ↓
┌──────────────────────────────────────┐
│  EduVid Backend (FastAPI)            │
│  Port 8088 in Fargate                │
└──────────────────────────────────────┘
```

---

## Advantages

| Aspect | Benefit |
|--------|---------|
| **No hardcoded URLs** | Frontend only knows the API Gateway URL (managed by AWS, stable) |
| **Serverless proxy** | Lambda handles routing, can add auth, logging, request validation without touching EduVid |
| **Cost-effective** | Lambda + API Gateway is cheaper than keeping a second ALB warm |
| **Scalability** | Lambda auto-scales; handles traffic spikes without provisioning |
| **Security** | Lambda can run in VPC, call EduVid privately; no public EduVid endpoint needed |
| **Monitoring** | CloudWatch + X-Ray for Lambda execution tracking |
| **No cross-origin issues** | Single entry point (API Gateway) makes CORS simpler |

---

## Disadvantages

| Aspect | Consideration |
|--------|----------------|
| **Cold starts** | Lambda has ~100-500ms startup latency on first invoke; can add provisioned concurrency if latency is critical |
| **Additional layer** | One more AWS service to operate and monitor |
| **VPC networking** | If Lambda needs to call Fargate in private subnet, must configure VPC + NAT; adds complexity |
| **Job storage** | EduVid uses in-memory job dict; if you scale EduVid horizontally, need persistent storage (Redis, DynamoDB) |

---

## Implementation Plan

### Phase 1: Create Lambda Functions

#### 1.1 Create a new Lambda function: `eduvid-proxy`

- **Runtime:** Python 3.12
- **Handler:** `index.handler`
- **Memory:** 256 MB (lightweight proxy)
- **Timeout:** 30 seconds

#### 1.2 Lambda code structure

Create `lambda_function.py`:

```python
import json
import httpx
import os
from typing import Any

EDUVID_BASE_URL = os.environ.get("EDUVID_BASE_URL", "http://eduvid-backend:8088")

async def generate(event: dict) -> dict:
    """Proxy POST /generate to EduVid backend."""
    try:
        body = json.loads(event.get("body", "{}"))
        concept = body.get("concept", "").strip()
        
        if not concept or len(concept) < 3:
            return {
                "statusCode": 400,
                "body": json.dumps({"error": "Concept must be 3-500 characters"})
            }
        
        async with httpx.AsyncClient() as client:
            response = await client.post(
                f"{EDUVID_BASE_URL}/generate",
                json={"concept": concept},
                timeout=10.0
            )
        
        if response.status_code != 200:
            return {
                "statusCode": response.status_code,
                "body": json.dumps({"error": response.text})
            }
        
        return {
            "statusCode": 200,
            "body": json.dumps(response.json())
        }
    except Exception as e:
        return {
            "statusCode": 500,
            "body": json.dumps({"error": str(e)})
        }


def status(event: dict) -> dict:
    """Proxy GET /status/{job_id} to EduVid backend."""
    try:
        job_id = event["pathParameters"].get("job_id")
        if not job_id:
            return {
                "statusCode": 400,
                "body": json.dumps({"error": "job_id required"})
            }
        
        import httpx
        response = httpx.get(
            f"{EDUVID_BASE_URL}/status/{job_id}",
            timeout=10.0
        )
        
        if response.status_code == 404:
            return {
                "statusCode": 404,
                "body": json.dumps({"error": "Job not found"})
            }
        
        return {
            "statusCode": 200,
            "body": json.dumps(response.json())
        }
    except Exception as e:
        return {
            "statusCode": 500,
            "body": json.dumps({"error": str(e)})
        }


def handler(event: dict, context: Any) -> dict:
    """Route to appropriate handler based on path and method."""
    path = event.get("path", "")
    method = event.get("httpMethod", "").upper()
    
    if path == "/generate" and method == "POST":
        # For async Lambda, wrap coroutine or use boto3 SQS
        return generate(event)
    elif path.startswith("/status/") and method == "GET":
        return status(event)
    
    return {
        "statusCode": 404,
        "body": json.dumps({"error": "Not found"})
    }
```

#### 1.3 Lambda dependencies

Create `lambda/requirements.txt`:

```
httpx>=0.28.1
boto3>=1.43.98
```

#### 1.4 Deployment via SAM or manual

**Option A: AWS Serverless Application Model (SAM)** template:

Create `template.yaml`:

```yaml
AWSTemplateFormatVersion: '2010-09-09'
Transform: AWS::Serverless-2010-05-13

Parameters:
  EduVidBaseUrl:
    Type: String
    Default: "http://eduvid-backend-alb:8088"
    Description: EduVid backend base URL

Resources:
  EduVidProxyFunction:
    Type: AWS::Serverless::Function
    Properties:
      CodeUri: lambda/
      Handler: index.handler
      Runtime: python3.12
      Timeout: 30
      MemorySize: 256
      Environment:
        Variables:
          EDUVID_BASE_URL: !Ref EduVidBaseUrl
      Events:
        GenerateApi:
          Type: Api
          Properties:
            RestApiId: !Ref EduVidApi
            Path: /generate
            Method: POST
        StatusApi:
          Type: Api
          Properties:
            RestApiId: !Ref EduVidApi
            Path: /status/{job_id}
            Method: GET

  EduVidApi:
    Type: AWS::ApiGateway::RestApi
    Properties:
      Name: eduvid-api
      Description: Proxy API for EduVid video generation

  ApiDeployment:
    Type: AWS::ApiGateway::Deployment
    DependsOn:
      - EduVidProxyFunction
    Properties:
      RestApiId: !Ref EduVidApi
      StageName: prod

Outputs:
  ApiEndpoint:
    Value: !Sub "https://${EduVidApi}.execute-api.${AWS::Region}.amazonaws.com/prod"
    Description: API Gateway endpoint URL
```

**Option B: Manual creation** via AWS Console:

1. Create REST API in API Gateway
2. Create resources: `/generate` (POST), `/status` (GET with `{job_id}` path parameter)
3. Integrate each with the Lambda function
4. Deploy to a stage (e.g., `prod`)

---

### Phase 2: Configure Lambda for VPC (if EduVid is private)

If EduVid Fargate runs in a private VPC subnet:

1. **Add VPC configuration to Lambda:**
   - Attach Lambda to the same VPC as EduVid
   - Assign to private subnet(s)
   - Attach security group that allows outbound to EduVid's security group

2. **EduVid Fargate security group:**
   - Inbound rule: port 8088 from Lambda security group

3. **DNS resolution:**
   - Use EduVid's internal service name (Fargate service discovery) or ALB DNS
   - Example: `http://eduvid-backend.internal:8088` (if using Route 53 private hosted zone)

**Lambda environment variable:**

```
EDUVID_BASE_URL = http://eduvid-backend.internal:8088
```

---

### Phase 3: Update Frontend to Use API Gateway

#### 3.1 Remove `VITE_EDUVID_API_URL` from `.env`

Remove or stop using the ALB-based URL configuration.

#### 3.2 Create `src/config.ts` with API Gateway URL

```typescript
// Get from AWS Outputs or hardcode for your environment
export const API_GATEWAY_URL = "https://abc123xyz.execute-api.us-east-1.amazonaws.com/prod";
```

Or inject at build time via environment:

```typescript
export const API_GATEWAY_URL = import.meta.env.VITE_API_GATEWAY_URL 
  || "https://abc123xyz.execute-api.us-east-1.amazonaws.com/prod";
```

#### 3.3 Update `src/services/api.ts`

```typescript
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
```

#### 3.4 Update `App.tsx`

Use the API Gateway-based service in the component:

```typescript
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
    if (e.key === 'Enter' && !isSubmitting) {
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
            disabled={isSubmitting}
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
```

---

### Phase 4: Enable CORS on API Gateway

1. **Create a Lambda authorizer (optional)** or enable simple CORS

2. **In API Gateway Console:**
   - Select `/generate` resource → Method `OPTIONS`
   - Add CORS headers to response
   - Or use a SAM template to auto-configure:

```yaml
Resources:
  EduVidApi:
    Type: AWS::ApiGateway::RestApi
    Properties:
      Name: eduvid-api
      
  ProxyResource:
    Type: AWS::ApiGateway::Resource
    Properties:
      RestApiId: !Ref EduVidApi
      ParentId: !GetAtt EduVidApi.RootResourceId
      PathPart: generate

  ProxyMethod:
    Type: AWS::ApiGateway::Method
    Properties:
      RestApiId: !Ref EduVidApi
      ResourceId: !Ref ProxyResource
      HttpMethod: POST
      AuthorizationType: NONE
      Integration:
        Type: AWS_PROXY
        IntegrationHttpMethod: POST
        Uri: !Sub "arn:aws:apigateway:${AWS::Region}:lambda:path/2015-03-31/functions/${EduVidProxyFunction.Arn}/invocations"

  ApiCorsResponse:
    Type: AWS::ApiGateway::Response
    Properties:
      RestApiId: !Ref EduVidApi
      ResponseType: DEFAULT_4XX
      ResponseParameters:
        gatewayresponse.header.Access-Control-Allow-Origin: "'*'"
        gatewayresponse.header.Access-Control-Allow-Headers: "'*'"
```

---

### Phase 5: Monitoring & Logging

1. **CloudWatch Logs:**
   - Lambda execution logs automatically go to `/aws/lambda/eduvid-proxy`
   - Helpful for debugging request routing

2. **API Gateway Logging:**
   - Enable execution logs in API stage settings
   - Logs full request/response payloads

3. **X-Ray (optional):**
   - Add `AWS_XRAY_SDK_ENABLED=true` to Lambda env
   - Trace calls from API Gateway → Lambda → EduVid

---

## Deployment Files to Create

| File | Purpose |
|------|---------|
| `lambda/index.py` | Lambda handler logic |
| `lambda/requirements.txt` | Dependencies (`httpx`, `boto3`) |
| `template.yaml` (SAM) | Infrastructure-as-code for API Gateway + Lambda |
| `src/config.ts` (Frontend) | API Gateway URL constant |
| `src/services/api.ts` (Frontend) | HTTP client using API Gateway |

---

## Comparison: ALB URL vs API Gateway

| Aspect | ALB Direct | API Gateway + Lambda |
|--------|-----------|---------------------|
| **Frontend config** | `VITE_EDUVID_API_URL=http://alb-dns:8088` | `VITE_API_GATEWAY_URL=https://xyz.execute-api...` (stable) |
| **Routing complexity** | Simple pass-through | Lambda can add auth, logging, rate limiting |
| **Cold starts** | None (always warm) | ~100-500ms first invoke |
| **Provisioning** | Requires ALB, target groups | Serverless, auto-scaling |
| **VPC complexity** | Simple (ALB in public/private) | More complex (Lambda VPC config) |
| **Scalability** | Limited by ALB capacity | Unlimited (Lambda concurrent executions) |

---

## Recommendation

### Use API Gateway + Lambda if:
- You want a clean, decoupled API boundary
- You plan to add authentication, rate limiting, or request transformation later
- You want to avoid exposing EduVid's ALB publicly
- You're comfortable with Lambda cold starts

### Use ALB Direct if:
- You want the simplest path to get working
- You need sub-100ms latency on every request
- You're already managing ALBs elsewhere

**For a production video generation tool, API Gateway + Lambda is recommended** because:
1. You can add authentication (e.g., API key, Cognito) later
2. The stable HTTPS endpoint is good for long-term maintainability
3. Lambda can queue jobs to SQS if needed in the future
4. No need to manage public ALB credentials

---

## Next Steps

1. Choose deployment method (SAM or manual AWS Console)
2. Create Lambda function with proxy logic
3. Set up API Gateway with routes and CORS
4. Configure Lambda VPC (if EduVid is private)
5. Update frontend to use API Gateway URL
6. Test end-to-end flow from frontend through Lambda to EduVid
7. Enable CloudWatch logging and monitoring
8. Consider adding provisioned concurrency if cold starts become a bottleneck
