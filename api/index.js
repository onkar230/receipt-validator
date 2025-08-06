const https = require('https');
const express = require('express');
const app = express();

app.use(express.json());

// Apple App Store URLs
const PRODUCTION_URL = 'https://buy.itunes.apple.com/verifyReceipt';
const SANDBOX_URL = 'https://sandbox.itunes.apple.com/verifyReceipt';

// Your App Store Connect shared secret (you'll need to set this)
const SHARED_SECRET = process.env.APPLE_SHARED_SECRET || 'a374b8c7a3b346b5ab7bfc234e69924d';

/**
 * Validates receipt with Apple's servers using the recommended approach:
 * 1. Try production first
 * 2. If it fails with sandbox error, try sandbox
 */
async function validateReceipt(receiptData, sharedSecret = SHARED_SECRET) {
  const payload = {
    'receipt-data': receiptData,
    'password': sharedSecret,
    'exclude-old-transactions': true
  };

  try {
    // First, try production
    const productionResult = await makeAppleRequest(PRODUCTION_URL, payload);
    
    // If production succeeds, return the result
    if (productionResult.status === 0) {
      return {
        success: true,
        environment: 'production',
        data: productionResult
      };
    }
    
    // If we get the sandbox receipt error (status 21007), try sandbox
    if (productionResult.status === 21007) {
      console.log('Production receipt validation failed with sandbox error, trying sandbox...');
      
      const sandboxResult = await makeAppleRequest(SANDBOX_URL, payload);
      
      if (sandboxResult.status === 0) {
        return {
          success: true,
          environment: 'sandbox',
          data: sandboxResult
        };
      }
      
      return {
        success: false,
        environment: 'sandbox',
        error: `Sandbox validation failed with status: ${sandboxResult.status}`,
        data: sandboxResult
      };
    }
    
    // Production failed for other reasons
    return {
      success: false,
      environment: 'production',
      error: `Production validation failed with status: ${productionResult.status}`,
      data: productionResult
    };
    
  } catch (error) {
    console.error('Receipt validation error:', error);
    return {
      success: false,
      environment: 'unknown',
      error: error.message
    };
  }
}

/**
 * Makes HTTPS request to Apple's receipt validation endpoint
 */
function makeAppleRequest(url, payload) {
  return new Promise((resolve, reject) => {
    const postData = JSON.stringify(payload);
    
    const options = {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(postData)
      }
    };
    
    const req = https.request(url, options, (res) => {
      let data = '';
      
      res.on('data', (chunk) => {
        data += chunk;
      });
      
      res.on('end', () => {
        try {
          const response = JSON.parse(data);
          resolve(response);
        } catch (error) {
          reject(new Error(`Failed to parse Apple response: ${error.message}`));
        }
      });
    });
    
    req.on('error', (error) => {
      reject(new Error(`Request failed: ${error.message}`));
    });
    
    req.write(postData);
    req.end();
  });
}

/**
 * Checks if a receipt contains valid active subscriptions
 */
function hasActiveSubscription(validationResult, productId) {
  if (!validationResult.success || !validationResult.data.receipt) {
    return false;
  }
  
  const receipt = validationResult.data.receipt;
  
  // Check latest receipt info for auto-renewable subscriptions
  if (receipt.latest_receipt_info) {
    const now = Date.now();
    
    for (const transaction of receipt.latest_receipt_info) {
      if (transaction.product_id === productId) {
        const expiresDate = parseInt(transaction.expires_date_ms);
        
        // Check if subscription is still active
        if (expiresDate > now) {
          return true;
        }
      }
    }
  }
  
  // Fallback: check in_app purchases for non-renewable products
  if (receipt.in_app) {
    for (const purchase of receipt.in_app) {
      if (purchase.product_id === productId) {
        // For non-renewable products, just check if purchase exists
        // You might want to add additional logic here based on your product type
        return true;
      }
    }
  }
  
  return false;
}

// API Routes
app.post('/validate-receipt', async (req, res) => {
  try {
    const { receiptData, productId } = req.body;
    
    if (!receiptData) {
      return res.status(400).json({
        success: false,
        error: 'Receipt data is required'
      });
    }
    
    if (!productId) {
      return res.status(400).json({
        success: false,
        error: 'Product ID is required'
      });
    }
    
    // Validate the receipt
    const validationResult = await validateReceipt(receiptData);
    
    if (!validationResult.success) {
      return res.status(400).json({
        success: false,
        error: validationResult.error,
        environment: validationResult.environment
      });
    }
    
    // Check if user has active subscription
    const hasActiveSub = hasActiveSubscription(validationResult, productId);
    
    res.json({
      success: true,
      isPremium: hasActiveSub,
      environment: validationResult.environment,
      receipt: validationResult.data.receipt
    });
    
  } catch (error) {
    console.error('Validation endpoint error:', error);
    res.status(500).json({
      success: false,
      error: 'Internal server error'
    });
  }
});

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ status: 'healthy', timestamp: new Date().toISOString() });
});

const serverless = require('serverless-http');
module.exports.handler = serverless(app);