import * as functions from 'firebase-functions';
import * as admin from 'firebase-admin';
import { Configuration, PlaidApi, PlaidEnvironments, Products } from 'plaid';
// Initialize Firebase Admin 
admin.initializeApp();

// Plaid client setup
const configuration = new Configuration({
    basePath: PlaidEnvironments.sandbox, 
    baseOptions: {
        headers: {
        'PLAID-CLIENT-ID': '660454e141d17b001c95d558', 
        'PLAID-SECRET': '24f497e18747f1ca671056ac2fe51c',
        }, 
    },
});

const client = new PlaidApi(configuration); // Firestore reference
const db = admin.firestore();

/**
 * Creates new public tokens for a set of predefined institution IDs and clears any existing tokens from the Firestore.
 * This function is designed to be triggered via an HTTP request.
 *
 * @param {functions.https.Request} req - The HTTP request object.
 * @param {functions.https.Response} res - The HTTP response object.
 */
exports.createPublicTokens = functions.https.onRequest(async (req, res) => {
    
    // These ids are Chase, BoA, and Capital One
    // pre-fetched with endpoint /institutions/search using postman
    const institutionIds = ['ins_56', 'ins_127989', 'ins_128026'];
    const initialProducts = [Products.Transactions]; 
    try {
        // Step 1: Clear existing tokens from Firestore to remove excess token in a testing environment
        const tokensSnapshot = await db.collection('publicTokens').get(); 
        const batch = db.batch();
        
        tokensSnapshot.forEach(doc => {
            batch.delete(doc.ref); // Add each document to the batch delete 
        });
        
        await batch.commit(); // Execute the batch delete
        
        // Create a token each for the three institutions
        for (const institutionId of institutionIds) {
            const response = await client.sandboxPublicTokenCreate({
                institution_id: institutionId,
                initial_products: initialProducts, 
            });
            
            // Create a new document for each new token, and store the token
            const newDocRef = db.collection('publicTokens').doc(); 
            await newDocRef.set({ token: response.data.public_token }); 
        }
        // Respond with the array of generated public tokens
        res.status(200).send({ success: true, message: 'New public tokens generated and old tokens cleared.' }); 
    
    } catch (error) {
        console.error('Failed to create public tokens:', error);
        res.status(500).send('Failed to create public tokens'); }
});
    
/**
 * Exchanges public tokens for access tokens and updates the Firestore `accessTokens` collection.
 * This function is intended to be triggered via an HTTP request.
 *
 * @param req - The HTTP request object.
 * @param res - The HTTP response object.
 */
exports.exchangePublicTokensAndStore = functions.https.onRequest(async (req, res) => { 
    try {
        // Step 1: Retrieve public tokens from Firestore
        const publicTokensSnapshot = await db.collection('publicTokens').get();
        const publicTokens: string[] = publicTokensSnapshot.docs.map(doc => doc.data().token);

        if (publicTokens.length === 0) {
            res.status(404).send({ error: 'No public tokens found in Firestore.' }); 
            return;
        }

        // Step 2: Clear existing access tokens from Firestore
        const accessTokensSnapshot = await db.collection('accessTokens').get(); 
        const batchDelete = db.batch();
        
        accessTokensSnapshot.forEach(doc => {
            batchDelete.delete(doc.ref); // Queue each document for deletion 
        });
        
        // Execute the batch deletion
        await batchDelete.commit();
        
        // Step 3: Exchange each public token for an access token and store them 
        const batchStore = db.batch();

        for (const publicToken of publicTokens) {
            const response = await client.itemPublicTokenExchange({ public_token: publicToken }); 
            const accessToken = response.data.access_token;
            const newDocRef = db.collection('accessTokens').doc(); // Create a new document for each access token
            batchStore.set(newDocRef, { accessToken: accessToken }); 
        }
        
        // Store all new access tokens in Firestore 
        await batchStore.commit(); 
        
        res.status(200).send({ success: true, message: 'Access tokens updated successfully.' });

    } catch (error) {
        console.error('Error exchanging public tokens:', error);
        res.status(500).send({ success: false, message: 'Failed to exchange public tokens.' });
}});


/**
 * Fetches transactions within a specified date range for each access token stored in Firestore,
 * then stores these transactions in the Firestore `transactions` collection.
 * This function is triggered via an HTTP POST request.
 * 
 * @param {functions.https.Request} req - The HTTP request object, containing the start and end dates.
 * @param {functions.https.Response} res - The HTTP response object used to send responses back to the client.
 */

exports.getTransactions = functions.https.onRequest(async (req, res) => { 
    try {
        const startDate: string = req.body.start_date; 
        const endDate: string = req.body.end_date;
        
        // Step 1: Retrieve access tokens from Firestore
        const accessTokensSnapshot = await db.collection('accessTokens').get();
        const accessTokens: string[] = accessTokensSnapshot.docs.map(doc => doc.data().accessToken);
        
        if (accessTokens.length === 0) {
            res.status(404).send({ error: 'No access tokens found in Firestore.' }); 
            return;
        }

        // Delete old transactions
        const transactionsSnapshot = await db.collection('transactions').get(); 
        transactionsSnapshot.forEach(doc => {
            doc.ref.delete();
        });

        // Step 2: Iterate over each access token to fetch and store transactions 
        // transactionsGet is the endpoint for /transactions/get 
        for (const accessToken of accessTokens) {
            const transactionsResponse = await client.transactionsGet({ 
                access_token: accessToken, 
                start_date: startDate,
                end_date: endDate,
            });
            
            // Step 3: Store the transaction data to firestore
            const transactions = transactionsResponse.data.transactions; 
            const batch = db.batch();

            transactions.forEach(transaction => {
                const docRef = db.collection('transactions').doc(transaction.transaction_id); 
                batch.set(docRef, transaction);
            });

            await batch.commit(); 
        }

        res.status(200).send({ 
            success: true,
            message: 'Transactions fetched and stored successfully for all tokens.' });
        
    } catch (error) {
        console.error('Error fetching transactions:', error);
        res.status(500).send({ 
            success: false, 
            message: 'Failed to fetch transactions for one or more tokens.' }); }
    });

/**
 * Calculates the total expenditure per category from transactions stored in Firestore and estimates
 * monthly budgets by dividing the totals by a predefined number.
 *
 * @param req - The HTTP request object.
 * @param res - The HTTP response object used to send responses back to the client.
 */

exports.calculateMonthlyBudget = functions.https.onRequest(async (req, res) => {
     try {
        // Step 1: Fetch the transaction from database
        const transactionsSnapshot = await db.collection('transactions').get(); 
        const transactions = transactionsSnapshot.docs.map(doc => doc.data());
        
        interface TotalsByCategory {
            [category: string]: { 
                total: number; 
                // count: number 
            };
        }
    
        // Step 2: Aggregate transactions by category
        const totalsByCategory: TotalsByCategory = {};

        transactions.forEach(transaction => {
            const category: string = transaction.category[0]; // Assuming top-level category 
            const amount: number = transaction.amount;

            if (!totalsByCategory[category]) { 
                totalsByCategory[category] = { 
                    total: 0
                    // count: 0 
                };
            }
        
        totalsByCategory[category].total += amount;
        // totalsByCategory[category].count++; 
    });

        // Calculate average monthly budget per category
        const monthlyBudgets: { [category: string]: number } = {}; 
        for (const category in totalsByCategory) {
            const { total } = totalsByCategory[category];
            monthlyBudgets[category] = total / 2; 
            // can be modified for user's input
            // currently transaction test data provided are all in the range 20240101-20240229
        }
        
        res.status(200).send({ success: true, monthlyBudgets }); 
    
    } catch (error) {
        console.error('Error calculating monthly budgets:', error);
        res.status(500).send({ success: false, message: 'Failed to calculate monthly budgets.' }); 
    }
});
