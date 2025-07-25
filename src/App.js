import React, { useState, useEffect, useRef } from 'react';
import { initializeApp } from 'firebase/app';
import { getAuth, signInAnonymously, signInWithCustomToken, onAuthStateChanged } from 'firebase/auth';
import { getFirestore, doc, getDoc, setDoc } from 'firebase/firestore';

// IMPORTANT: For online deployment (e.g., Netlify, Firebase Hosting), you will need to set these Firebase
// configuration values as environment variables in your hosting platform.
// For Create React App, environment variables must be prefixed with REACT_APP_ (e.g., REACT_APP_FIREBASE_API_KEY).
// During the build process (npm run build), CRA injects these into your client-side code.

// Firebase configuration using environment variables (for Netlify/production)
// During local development or in the Canvas environment, these might fall back to __firebase_config
// or empty strings if not explicitly set.
const firebaseConfig = {
  apiKey: process.env.REACT_APP_FIREBASE_API_KEY || (typeof __firebase_config !== 'undefined' ? JSON.parse(__firebase_config).apiKey : ''),
  authDomain: process.env.REACT_APP_FIREBASE_AUTH_DOMAIN || (typeof __firebase_config !== 'undefined' ? JSON.parse(__firebase_config).authDomain : ''),
  projectId: process.env.REACT_APP_FIREBASE_PROJECT_ID || (typeof __firebase_config !== 'undefined' ? JSON.parse(__firebase_config).projectId : ''),
  storageBucket: process.env.REACT_APP_FIREBASE_STORAGE_BUCKET || (typeof __firebase_config !== 'undefined' ? JSON.parse(__firebase_config).storageBucket : ''),
  messagingSenderId: process.env.REACT_APP_FIREBASE_MESSAGING_SENDER_ID || (typeof __firebase_config !== 'undefined' ? JSON.parse(__firebase_config).messagingSenderId : ''),
  appId: process.env.REACT_APP_FIREBASE_APP_ID || (typeof __firebase_config !== 'undefined' ? JSON.parse(__firebase_config).appId : ''),
  measurementId: process.env.REACT_APP_FIREBASE_MEASUREMENT_ID || (typeof __firebase_config !== 'undefined' ? JSON.parse(__firebase_config).measurementId : ''),
};

// initialAuthToken is specific to Canvas. For live deployment, standard Firebase auth methods are used,
// or you might provide a custom token from a backend if your app structure requires it.
const initialAuthToken = typeof __initial_auth_token !== 'undefined' ? __initial_auth_token : null;

// The appId for Firestore paths. Prioritize Canvas's __app_id, then a Netlify/Firebase env var, then a hardcoded fallback.
// This is used to create a unique path for your app's data in Firestore.
const APP_ID_FOR_FIRESTORE = typeof __app_id !== 'undefined' ? __app_id : (process.env.REACT_APP_APP_ID || 'psychoai-test-app');


function App() {
  const [firebaseApp, setFirebaseApp] = useState(null);
  const [auth, setAuth] = useState(null);
  const [db, setDb] = useState(null);
  const [userId, setUserId] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null); // General application errors
  const [pdfLibsLoaded, setPdfLibsLoaded] = useState(false);

  const [stage, setStage] = useState('welcome'); // 'welcome', 'topicSelection', 'questionnaire', 'results'
  const [selectedTopic, setSelectedTopic] = useState('');
  const [questions, setQuestions] = useState([]);
  const [userAnswers, setUserAnswers] = useState({}); // Initialize as empty object
  const [analysisResult, setAnalysisResult] = useState(null);
  const [stabilityLevels, setStabilityLevels] = useState(null);
  const [aiLoading, setAiLoading] = useState(false);
  const [showExitConfirmation, setShowExitConfirmation] = useState(false);
  const [customTopic, setCustomTopic] = useState('');
  const [showTopicWarning, setShowTopicWarning] = useState(false);
  const [topicWarningMessage, setTopicWarningMessage] = useState('');
  const [numQuestions, setNumQuestions] = useState(5); // New state for number of questions
  const [unansweredQuestionIndices, setUnansweredQuestionIndices] = useState([]); // New state for highlighting
  const [questionnaireError, setQuestionnaireError] = useState(null); // Specific error for questionnaire validation

  const mainContentRef = useRef(null); // Ref for the main content container to scroll
  const aiLoadingRef = useRef(null); // Ref for the AI loading indicator (within the overlay)
  const contentRef = useRef(null); // Ref for the content to be downloaded as PDF (results section)

  // Predefined topics for the psychological test
  const psychologicalTopics = [
    "Stress Level Assessment",
    "Personality Traits",
    "Anxiety Check",
    "Emotional Intelligence",
    "Self-Esteem Evaluation",
    "Coping Mechanisms",
    "Mindfulness & Well-being"
  ];

  // Helper to get Firestore doc ref for answered questions
  // This function relies on 'db' being initialized, which happens in useEffect.
  // It's called within async functions that wait for 'db' to be ready.
  const getAnsweredQuestionsDocRef = (topic, currentUserId) => {
    // Ensure topic is URL-friendly for document ID
    const docId = topic.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
    return doc(db, `artifacts/${APP_ID_FOR_FIRESTORE}/users/${currentUserId}/answeredQuestions`, docId);
  };

  // Function to generate questions using Gemini API
  const generateQuestions = async (topic) => {
    setAiLoading(true);
    setError(null); // Clear general errors
    setQuestionnaireError(null); // Clear questionnaire errors
    setUnansweredQuestionIndices([]); // Clear previous highlights
    // Scroll the main content to the top to show the AI thinking overlay
    mainContentRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });

    try {
      // 1. Fetch previously answered questions for this topic and user
      let answeredQuestionTexts = [];
      const currentUserId = auth.currentUser?.uid;
      if (db && currentUserId) {
        const docRef = getAnsweredQuestionsDocRef(topic, currentUserId);
        const docSnap = await getDoc(docRef);
        if (docSnap.exists()) {
          answeredQuestionTexts = docSnap.data().questions || [];
        }
      }

      // 2. Generate new questions from AI
      const prompt = `Generate ${numQuestions} multiple-choice questions for a psychological test on "${topic}". Each question should have 4 answer options, ranging from "Strongly Disagree" to "Strongly Agree". Ensure the questions are relevant to psychological assessments and based on general psychological principles. Provide the output in JSON format: [{question: '...', options: ['...', '...', '...', '...']}, ...].`;
      let chatHistory = [];
      chatHistory.push({ role: "user", parts: [{ text: prompt }] });

      const payload = {
        contents: chatHistory,
        generationConfig: {
          responseMimeType: "application/json",
          responseSchema: {
            type: "ARRAY",
            items: {
              type: "OBJECT",
              properties: {
                "question": { "type": "STRING" },
                "options": {
                  "type": "ARRAY",
                  "items": { "type": "STRING" }
                }
              },
              "propertyOrdering": ["question", "options"]
            }
          }
        }
      };

      // THIS IS THE LINE THAT USES THE API KEY
      const apiKey = process.env.REACT_APP_GEMINI_API_KEY; // Now using the environment variable
      const apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`;

      const response = await fetch(apiUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });

      const result = await response.json();
      if (!result.candidates || result.candidates.length === 0 ||
          !result.candidates[0].content || !result.candidates[0].content.parts ||
          result.candidates[0].content.parts.length === 0) {
        setError("Failed to generate questions. Please try again.");
        console.error("Gemini API response structure unexpected:", result);
        return;
      }

      const jsonString = result.candidates[0].content.parts[0].text;
      let parsedQuestions = JSON.parse(jsonString);

      // 3. Filter out already answered questions
      let newQuestions = parsedQuestions.filter(q => !answeredQuestionTexts.includes(q.question));

      // 4. Handle all questions answered / allow repetition
      if (newQuestions.length < numQuestions && answeredQuestionTexts.length > 0) {
        // If not enough new questions, and some have been answered, reset answered list
        console.log("All unique questions answered for this topic. Resetting answered list.");
        if (db && currentUserId) {
          const docRef = getAnsweredQuestionsDocRef(topic, currentUserId);
          await setDoc(docRef, { questions: [] }); // Clear answered questions for this topic
        }
        // Use the original parsedQuestions (allowing repetition)
        setQuestions(parsedQuestions);
      } else if (newQuestions.length === 0 && answeredQuestionTexts.length === 0) {
        // If no new questions and no history, just use what AI gave (might be empty or few)
        setQuestions(parsedQuestions);
      }
      else {
        setQuestions(newQuestions.slice(0, numQuestions)); // Take only the requested number of unique questions
      }

      setUserAnswers({}); // Reset answers for new test
      setStage('questionnaire');
    } catch (apiError) {
      setError(`Error generating questions: ${apiError.message}. Please check your network connection or try again.`);
      console.error("Error calling Gemini API for questions:", apiError);
    } finally {
      setAiLoading(false);
    }
  };

  // Function to analyze results using Gemini API
  const analyzeResults = async () => {
    // 1. Validate all questions are answered
    const unansweredIndices = [];
    questions.forEach((_, index) => {
      if (userAnswers[index] === undefined) {
        unansweredIndices.push(index);
      }
    });

    if (unansweredIndices.length > 0) {
      setUnansweredQuestionIndices(unansweredIndices);
      setQuestionnaireError("Please answer all questions before proceeding. Unanswered questions are highlighted in red.");
      // Scroll to the top of the content to show the error and highlighted questions
      mainContentRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      return;
    }

    setAiLoading(true);
    setError(null); // Clear general errors
    setQuestionnaireError(null); // Clear questionnaire errors
    setUnansweredQuestionIndices([]); // Clear any previous highlights
    // Scroll the main content to the top to show the AI thinking overlay
    mainContentRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });

    try {
      const formattedAnswers = questions.map((q, index) => ({
        question: q.question,
        userAnswer: userAnswers[index] || 'No answer provided'
      }));

      // Adjust analysis prompt based on number of questions
      const analysisPromptBase = `Based on the following psychological test on "${selectedTopic}", with questions and user answers: ${JSON.stringify(formattedAnswers)}.`;
      let analysisPrompt;
      if (numQuestions === 15) {
        analysisPrompt = `${analysisPromptBase} Provide a *comprehensive and detailed analysis* of the user's psychological state related to the topic, exploring nuances and potential underlying factors. Offer *in-depth, personalized, and actionable strategies* as advice. Structure your response as a JSON object with 'analysis' and 'advice' fields.`;
      } else { // numQuestions === 5
        analysisPrompt = `${analysisPromptBase} Provide a *brief and easy-to-understand* analysis of the user's psychological state related to the topic. Focus on *key insights*. Also, provide *brief, actionable steps* as advice. Structure your response as a JSON object with 'analysis' and 'advice' fields.`;
      }

      let chatHistory = [];
      chatHistory.push({ role: "user", parts: [{ text: analysisPrompt }] });

      const analysisPayload = {
        contents: chatHistory,
        generationConfig: {
          responseMimeType: "application/json",
          responseSchema: {
            type: "OBJECT",
            properties: {
              "analysis": { "type": "STRING" },
              "advice": { "type": "STRING" }
            },
            "propertyOrdering": ["analysis", "advice"]
          }
        }
      };

      // THIS IS THE LINE THAT USES THE API KEY
      const apiKey = process.env.REACT_APP_GEMINI_API_KEY; // Now using the environment variable
      const apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`;

      const analysisResponse = await fetch(apiUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(analysisPayload)
      });

      const analysisResultData = await analysisResponse.json();
      let parsedAnalysis = null;
      if (analysisResultData.candidates && analysisResultData.candidates.length > 0 &&
        analysisResultData.candidates[0].content && analysisResultData.candidates[0].content.parts &&
        analysisResultData.candidates[0].content.parts.length > 0) {
        const jsonString = stabilityResultData.candidates[0].content.parts[0].text; // Fixed: was stabilityResultData, now analysisResultData
        parsedAnalysis = JSON.parse(jsonString);
        setAnalysisResult(parsedAnalysis);
      } else {
        setError("Failed to analyze results. Please try again.");
        console.error("Gemini API response structure unexpected for analysis:", analysisResultData);
        setAiLoading(false);
        return;
      }

      // New AI call for stability levels
      const stabilityPrompt = `Based on the following psychological test answers on '${selectedTopic}': ${JSON.stringify(formattedAnswers)}. Assess the user's emotional, mental, and physical stability. For each category, provide a brief level (e.g., "Good", "Moderate", "Needs Attention") and suggest a relevant emoji (e.g., "😄", "😐", "😟"). Output in JSON: { "emotional": { "level": "...", "emoji": "..." }, "mental": { "level": "...", "emoji": "..." }, "physical": { "level": "...", "emoji": "..." } }.`;

      chatHistory = [];
      chatHistory.push({ role: "user", parts: [{ text: stabilityPrompt }] });

      const stabilityPayload = {
        contents: chatHistory,
        generationConfig: {
          responseMimeType: "application/json",
          responseSchema: {
            type: "OBJECT",
            properties: {
              "emotional": {
                type: "OBJECT",
                properties: { "level": { "type": "STRING" }, "emoji": { "type": "STRING" } },
                propertyOrdering: ["level", "emoji"]
              },
              "mental": {
                type: "OBJECT",
                properties: { "level": { "type": "STRING" }, "emoji": { "type": "STRING" } },
                propertyOrdering: ["level", "emoji"]
              },
              "physical": {
                type: "OBJECT",
                properties: { "level": { "type": "STRING" }, "emoji": { "type": "STRING" } },
                propertyOrdering: ["level", "emoji"]
              }
            },
            propertyOrdering: ["emotional", "mental", "physical"]
          }
        }
      };

      const stabilityResponse = await fetch(apiUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(stabilityPayload)
      });

      const stabilityResultData = await stabilityResponse.json();
      if (stabilityResultData.candidates && stabilityResultData.candidates.length > 0 &&
        stabilityResultData.candidates[0].content && stabilityResultData.candidates[0].content.parts &&
        stabilityResultData.candidates[0].content.parts.length > 0) {
        const jsonString = stabilityResultData.candidates[0].content.parts[0].text;
        const parsedStability = JSON.parse(jsonString);
        setStabilityLevels(parsedStability);
      } else {
        console.warn("Failed to generate stability levels. Response unexpected:", stabilityResultData);
      }

      // 2. Save answered questions to Firestore
      const currentUserId = auth.currentUser?.uid;
      if (db && currentUserId) {
        const docRef = getAnsweredQuestionsDocRef(selectedTopic, currentUserId);
        // Get existing questions to append, or initialize if none
        const docSnap = await getDoc(docRef);
        let existingQuestions = [];
        if (docSnap.exists()) {
          existingQuestions = docSnap.data().questions || [];
        }
        const newAnsweredQuestions = questions.map(q => q.question);
        const combinedQuestions = Array.from(new Set([...existingQuestions, ...newAnsweredQuestions])); // Ensure uniqueness

        await setDoc(docRef, { questions: combinedQuestions }, { merge: true });
        console.log("Answered questions saved to Firestore.");
      }

      setStage('results');

    } catch (apiError) {
      setError(`Error analyzing results or generating stability levels: ${apiError.message}. Please check your network connection or try again.`);
      console.error("Error calling Gemini API for analysis/stability:", apiError);
    } finally {
      setAiLoading(false);
    }
  };

  // Function to validate custom topic using Gemini API
  const validateCustomTopic = async () => {
    if (!customTopic.trim()) {
      setShowTopicWarning(true);
      setTopicWarningMessage("Please enter a topic.");
      return;
    }

    setAiLoading(true);
    setError(null); // Clear general errors
    setQuestionnaireError(null); // Clear questionnaire errors
    setShowTopicWarning(false); // Hide previous warnings
    setTopicWarningMessage('');
    // Scroll the main content to the top to show the AI thinking overlay
    mainContentRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });

    try {
      const prompt = `Is "${customTopic}" a topic primarily related to psychology, mental health, personality, emotions, or personal well-being? Respond with a JSON object: { "isPsychological": true/false, "reason": "..." }`;
      let chatHistory = [];
      chatHistory.push({ role: "user", parts: [{ text: prompt }] });

      const payload = {
        contents: chatHistory,
        generationConfig: {
          responseMimeType: "application/json",
          responseSchema: {
            type: "OBJECT",
            properties: {
              "isPsychological": { "type": "BOOLEAN" },
              "reason": { "type": "STRING" }
            },
            "propertyOrdering": ["isPsychological", "reason"]
          }
        }
      };

      // THIS IS THE LINE THAT USES THE API KEY
      const apiKey = process.env.REACT_APP_GEMINI_API_KEY; // Now using the environment variable
      const apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`;

      const response = await fetch(apiUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });

      const result = await response.json();
      if (!result.candidates || result.candidates.length === 0 ||
          !result.candidates[0].content || !result.candidates[0].content.parts ||
          result.candidates[0].content.parts.length === 0) {
        setError("Failed to validate topic. Please try again.");
        console.error("Gemini API response structure unexpected for topic validation:", result);
        return;
      }

      const jsonString = result.candidates[0].content.parts[0].text;
      const parsedValidation = JSON.parse(jsonString);

      if (parsedValidation.isPsychological) {
        setSelectedTopic(customTopic);
        generateQuestions(customTopic);
      } else {
        setShowTopicWarning(true);
        setTopicWarningMessage(`The topic "${customTopic}" does not seem to be related to psychology or mental health. This system is designed for psychological assessments. Please choose a relevant topic. Reason: ${parsedValidation.reason}`);
      }
    } catch (apiError) {
      setError(`Error validating topic: ${apiError.message}. Please check your network connection or try again.`);
      console.error("Error calling Gemini API for topic validation:", apiError);
    } finally {
      setAiLoading(false);
    }
  };

  // Handle user answer selection
  const handleAnswerChange = (questionIndex, answer) => {
    setUserAnswers(prev => ({
      ...prev,
      [questionIndex]: answer
    }));
    // Clear error and highlighting for this question if it was previously unanswered
    if (unansweredQuestionIndices.includes(questionIndex)) {
      setUnansweredQuestionIndices(prev => prev.filter(idx => idx !== questionIndex));
      // If no more unanswered questions, clear the questionnaire error
      if (unansweredQuestionIndices.length === 1 && questionnaireError) { // If this was the last one
        setQuestionnaireError(null);
      }
    }
  };

  // Handle PDF download using html2canvas and jsPDF
  const handleDownloadPdf = async () => {
    // Ensure PDF libraries are loaded before attempting to use them
    if (!pdfLibsLoaded || typeof window.html2canvas === 'undefined' || typeof window.jspdf === 'undefined' || typeof window.jspdf.jsPDF === 'undefined') {
      setError(`PDF generation failed: Required libraries are not fully loaded. Please wait a moment or refresh.`);
      console.error(`PDF generation failed: html2canvas or jspdf libraries are not loaded.`);
      return;
    }

    const input = contentRef.current;
    if (!input) {
      console.error("Content reference not found for PDF generation.");
      setError("Cannot generate PDF: Content not found.");
      return;
    }

    // Temporarily adjust styling for PDF generation if needed (e.g., remove scrollbars)
    const originalOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    try {
      // Access html2canvas and jsPDF from the global window object
      const html2canvas = window.html2canvas;
      const jsPDF = window.jspdf.jsPDF;

      const canvas = await html2canvas(input, {
        scale: 2, // Increase scale for better resolution
        useCORS: true, // Required if content includes images from other origins
        windowWidth: input.scrollWidth,
        windowHeight: input.scrollHeight,
      });

      const imgData = canvas.toDataURL('image/png');
      const pdf = new jsPDF('p', 'mm', 'a4');
      const imgWidth = 210; // A4 width in mm
      const pageHeight = 297; // A4 height in mm
      const imgHeight = canvas.height * imgWidth / canvas.width;
      let heightLeft = imgHeight;
      let position = 0;

      pdf.addImage(imgData, 'PNG', 0, position, imgWidth, imgHeight);
      heightLeft -= pageHeight;

      while (heightLeft >= 0) {
        position = heightLeft - imgHeight;
        pdf.addPage();
        pdf.addImage(imgData, 'PNG', 0, position, imgWidth, imgHeight);
        heightLeft -= pageHeight;
      }

      pdf.save(`${selectedTopic}_Test_Results.pdf`);
    } catch (pdfError) {
      console.error("Error generating PDF:", pdfError);
      setError("Failed to generate PDF. Please try again.");
    } finally {
      // Restore original styling
      document.body.style.overflow = originalOverflow;
    }
  };

  // Function to reset state and go to topic selection
  const confirmExitTest = () => {
    setShowExitConfirmation(false);
    setStage('topicSelection');
    setSelectedTopic('');
    setQuestions([]);
    setUserAnswers({});
    setAnalysisResult(null);
    setStabilityLevels(null);
    setCustomTopic('');
    setShowTopicWarning(false);
    setTopicWarningMessage('');
    setNumQuestions(5); // Reset to default 5 questions
    setError(null); // Clear any general errors
    setQuestionnaireError(null); // Clear any questionnaire errors
    setUnansweredQuestionIndices([]); // Clear highlights
  };

  // Initialize Firebase and dynamically load PDF libraries
  useEffect(() => {
    // Function to load a script dynamically, returns a Promise
    const loadScript = (src, id) => {
      return new Promise((resolve, reject) => {
        if (document.getElementById(id)) {
          resolve();
          return;
        }

        const script = document.createElement('script');
        script.src = src;
        script.id = id;
        script.onload = () => {
          console.log(`${id} loaded successfully.`);
          resolve();
        };
        script.onerror = () => {
          console.error(`Failed to load ${id} from ${src}`);
          reject(new Error(`Failed to load required library: ${id}. Please check your internet connection.`));
        };
        document.head.appendChild(script);
      });
    };

    // Load both jsPDF and html2canvas dynamically
    Promise.all([
      loadScript("https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js", "jspdf-script"),
      loadScript("https://cdnjs.cloudflare.com/ajax/libs/html2canvas/1.4.1/html2canvas.min.js", "html2canvas-script")
    ])
    .then(() => {
      setPdfLibsLoaded(true); // Mark all PDF libraries as loaded
      console.log("All PDF libraries are ready.");
    })
    .catch(err => {
      setError(err.message);
    });

    // Firebase initialization
    try {
      // Check if firebaseConfig has an apiKey before initializing
      // In a Create React App environment, process.env.REACT_APP_... variables are injected at build time.
      // In the Canvas environment, __firebase_config is provided.
      // This logic handles both.
      const isFirebaseConfigComplete = firebaseConfig.apiKey && firebaseConfig.authDomain && firebaseConfig.projectId;

      if (!isFirebaseConfigComplete) {
        console.warn("Firebase config is incomplete. Firebase will not be fully initialized until environment variables are set (for deployment) or __firebase_config is available (in Canvas).");
        // We don't set a hard error here to allow the app to render, but warn.
        // The actual Firebase operations will fail if config is truly missing.
      }

      const app = initializeApp(firebaseConfig);
      const authInstance = getAuth(app);
      const dbInstance = getFirestore(app);

      setFirebaseApp(app);
      setAuth(authInstance);
      setDb(dbInstance);

      // Listen for authentication state changes
      const unsubscribe = onAuthStateChanged(authInstance, async (user) => {
        if (user) {
          // User is signed in
          console.log("User signed in:", user.uid);
          setUserId(user.uid);
        } else {
          // User is signed out, attempt anonymous sign-in if no custom token
          console.log("No user signed in. Attempting anonymous sign-in or custom token sign-in.");
          try {
            if (initialAuthToken) {
              await signInWithCustomToken(authInstance, initialAuthToken);
              console.log("Signed in with custom token.");
            } else {
              await signInAnonymously(authInstance);
              console.log("Signed in anonymously.");
            }
          } catch (authError) {
            console.error("Firebase authentication error:", authError);
            setError(`Authentication failed: ${authError.message}`);
          }
        }
        setLoading(false); // Authentication check complete
      });

      // Clean up the listener on component unmount
      return () => unsubscribe();
    } catch (initError) {
      console.error("Firebase initialization error:", initError);
      setError(`Firebase initialization failed: ${initError.message}`);
      setLoading(false);
    }
  }, []); // Empty dependency array means this effect runs once on mount


  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-screen bg-gradient-to-br from-blue-100 to-indigo-200 text-gray-800">
        <div className="text-center p-6 bg-white bg-opacity-80 rounded-xl shadow-lg animate-pulse">
          <svg className="animate-spin h-8 w-8 text-blue-600 mx-auto mb-4" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
          </svg>
          <p className="text-lg font-semibold">Initializing application...</p>
        </div>
      </div>
    );
  }

  // Display a loading message for PDF libraries if they are not ready and not in a Firebase loading/error state
  if (!pdfLibsLoaded && !loading && !error) {
    return (
      <div className="flex items-center justify-center min-h-screen bg-gradient-to-br from-blue-100 to-indigo-200 text-gray-800">
        <div className="text-center p-6 bg-white bg-opacity-80 rounded-xl shadow-lg animate-pulse">
          <svg className="animate-spin h-8 w-8 text-blue-600 mx-auto mb-4" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
          </svg>
          <p className="text-lg font-semibold">Loading PDF capabilities...</p>
        </div>
      </div>
    );
  }

  // This block handles general application errors (e.g., Firebase init, PDF lib loading failure)
  // It should NOT handle questionnaire validation errors.
  if (error && !aiLoading && stage !== 'questionnaire') {
    return (
      <div className="flex items-center justify-center min-h-screen bg-gradient-to-br from-red-200 to-rose-300 text-red-800 p-4">
        <div className="text-center p-6 bg-white bg-opacity-80 rounded-xl shadow-lg">
          <h2 className="text-2xl font-bold mb-4">Error</h2>
          <p className="mb-6">{error}</p>
          <button
            onClick={() => window.location.reload()}
            className="px-6 py-3 bg-red-600 text-white font-semibold rounded-lg shadow-md hover:bg-red-700 transition duration-300 ease-in-out"
          >
            Reload Application
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-blue-100 to-indigo-200 flex flex-col items-center justify-center p-4 font-sans text-gray-800">
      <div className="bg-white p-8 rounded-xl shadow-2xl w-full max-w-3xl mx-auto my-8 flex flex-col items-center relative" ref={mainContentRef}>
        <h1 className="text-4xl font-extrabold text-center text-blue-800 mb-6">
          PsychoAI Test
        </h1>

        {userId && (
          <p className="text-sm text-gray-500 mb-4">
            Your User ID: <span className="font-mono text-blue-600 break-all">{userId}</span>
          </p>
        )}

        {aiLoading && (
          <div className="absolute inset-0 bg-white bg-opacity-80 flex items-center justify-center rounded-xl z-10 transition-opacity duration-300">
            <div className="text-center" ref={aiLoadingRef}>
              <svg className="animate-spin h-10 w-10 text-blue-600 mx-auto mb-4" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
          </svg>
          <p className="text-lg font-semibold text-blue-700">AI is thinking...</p>
            </div>
          </div>
        )}

        {showExitConfirmation && (
          <div className="fixed inset-0 bg-gray-800 bg-opacity-75 flex items-center justify-center z-50 transition-opacity duration-300">
            <div className="bg-white p-8 rounded-lg shadow-xl text-center max-w-sm mx-auto animate-fade-in">
              <h3 className="text-xl font-bold text-gray-800 mb-4">Confirm Exit</h3>
              <p className="text-gray-700 mb-6">
                Are you sure you want to exit the test? Your current progress will not be saved,
                and new questions will be generated if you start a new test.
              </p>
              <div className="flex justify-center gap-4">
                <button
                  onClick={() => setShowExitConfirmation(false)}
                  className="px-6 py-3 bg-gray-300 text-gray-800 font-semibold rounded-lg shadow-md hover:bg-gray-400 transition duration-300 ease-in-out"
                >
                  Cancel
                </button>
                <button
                  onClick={confirmExitTest}
                  className="px-6 py-3 bg-red-500 text-white font-semibold rounded-lg shadow-md hover:bg-red-600 transition duration-300 ease-in-out"
                >
                  Exit Test
                </button>
              </div>
            </div>
          </div>
        )}

        {stage === 'welcome' && (
          <div className="text-center transition-opacity duration-500 ease-in-out">
            <p className="text-lg text-gray-700 mb-8">
              Welcome to PsychoAI Test, your personal psychological assessment tool.
              Select a topic to begin your AI-powered questionnaire.
            </p>
            <button
              onClick={() => setStage('topicSelection')}
              className="px-8 py-4 bg-blue-600 text-white font-bold rounded-lg shadow-lg hover:bg-blue-700 transform hover:scale-105 transition duration-300 ease-in-out"
            >
              Start New Test
            </button>
          </div>
        )}

        {stage === 'topicSelection' && (
          <div className="w-full transition-opacity duration-500 ease-in-out">
            <h2 className="text-2xl font-bold text-center text-blue-700 mb-6">
              Choose a Test Topic
            </h2>

            <div className="mb-6">
              <h3 className="text-xl font-bold text-center text-gray-700 mb-4">
                Number of Questions:
              </h3>
              <div className="flex justify-center gap-4">
                <label className="inline-flex items-center cursor-pointer">
                  <input
                    type="radio"
                    name="numQuestions"
                    value="5"
                    checked={numQuestions === 5}
                    onChange={() => setNumQuestions(5)}
                    className="form-radio h-5 w-5 text-blue-600 focus:ring-blue-500"
                  />
                  <span className="ml-2 text-gray-700">5 Questions (Normal Analysis)</span>
                </label>
                <label className="inline-flex items-center cursor-pointer">
                  <input
                    type="radio"
                    name="numQuestions"
                    value="15"
                    checked={numQuestions === 15}
                    onChange={() => setNumQuestions(15)}
                    className="form-radio h-5 w-5 text-blue-600 focus:ring-blue-500"
                  />
                  <span className="ml-2 text-gray-700">15 Questions (Deep Analysis)</span>
                </label>
              </div>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-6">
              {psychologicalTopics.map((topic, index) => (
                <button
                  key={index}
                  onClick={() => {
                    setSelectedTopic(topic);
                    generateQuestions(topic);
                  }}
                  className="p-4 bg-blue-50 border border-blue-200 rounded-lg text-lg font-medium text-blue-800 hover:bg-blue-100 hover:shadow-md transition duration-200 ease-in-out transform hover:scale-105"
                >
                  {topic}
                </button>
              ))}
            </div>

            <div className="mt-8 pt-6 border-t border-gray-200">
              <h3 className="text-xl font-bold text-center text-gray-700 mb-4">
                Or Enter Your Own Topic
              </h3>
              <input
                type="text"
                value={customTopic}
                onChange={(e) => {
                  setCustomTopic(e.target.value);
                  setShowTopicWarning(false); // Hide warning when user types
                }}
                placeholder="e.g., 'Work-Life Balance', 'Social Anxiety'"
                className="w-full p-3 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-400 mb-4 text-gray-800"
              />
              {showTopicWarning && (
                <p className="text-red-500 text-sm mb-4 animate-fade-in">
                  {topicWarningMessage}
                </p>
              )}
              <button
                onClick={validateCustomTopic}
                disabled={aiLoading}
                className={`w-full px-6 py-3 bg-teal-600 text-white font-bold rounded-lg shadow-md hover:bg-teal-700 transform hover:scale-105 transition duration-300 ease-in-out
                  ${aiLoading ? 'opacity-50 cursor-not-allowed' : ''}`}
              >
                {aiLoading ? 'Validating Topic...' : 'Generate Custom Test'}
              </button>
            </div>

            <button
              onClick={() => setStage('welcome')}
              className="mt-8 px-6 py-3 bg-gray-200 text-gray-700 font-semibold rounded-lg shadow-md hover:bg-gray-300 transition duration-300 ease-in-out"
            >
              Back
            </button>
          </div>
        )}

        {stage === 'questionnaire' && (
          <div className="w-full transition-opacity duration-500 ease-in-out">
            <h2 className="text-2xl font-bold text-center text-blue-700 mb-6">
              {selectedTopic}
            </h2>
            <p className="text-md text-gray-600 text-center mb-6">
              Please answer the following questions honestly.
            </p>
            {questionnaireError && ( // Display questionnaire specific error here
              <div className="bg-red-100 border border-red-400 text-red-700 px-4 py-3 rounded relative mb-4" role="alert">
                <strong className="font-bold">Warning!</strong>
                <span className="block sm:inline"> {questionnaireError}</span>
              </div>
            )}
            <div className="space-y-8">
              {questions.map((q, qIndex) => (
                <div
                  key={qIndex}
                  className={`p-6 rounded-lg shadow-md border animate-fade-in-up
                    ${unansweredQuestionIndices.includes(qIndex)
                      ? 'bg-red-50 border-red-400' // Highlight in red
                      : 'bg-blue-50 border-blue-200' // Normal styling
                    }`}
                >
                  <p className="text-lg font-semibold text-gray-800 mb-4">
                    {qIndex + 1}. {q.question}
                  </p>
                  <div className="flex flex-col space-y-3">
                    {q.options.map((option, oIndex) => (
                      <label key={oIndex} className="inline-flex items-center cursor-pointer">
                        <input
                          type="radio"
                          name={`question-${qIndex}`}
                          value={option}
                          checked={userAnswers[qIndex] === option}
                          onChange={() => handleAnswerChange(qIndex, option)}
                          className="form-radio h-5 w-5 text-blue-600 border-gray-300 focus:ring-blue-500 rounded-full"
                        />
                        <span className="ml-3 text-gray-700 text-base">{option}</span>
                      </label>
                    ))}
                  </div>
                </div>
              ))}
            </div>
            <div className="flex justify-between mt-8">
              <button
                onClick={() => setShowExitConfirmation(true)}
                className="px-6 py-3 bg-gray-200 text-gray-700 font-semibold rounded-lg shadow-md hover:bg-gray-300 transition duration-300 ease-in-out"
              >
                Back to Topics
              </button>
              <button
                onClick={analyzeResults}
                disabled={aiLoading} // Disable only when AI is loading
                className={`px-8 py-4 bg-green-600 text-white font-bold rounded-lg shadow-lg hover:bg-green-700 transform hover:scale-105 transition duration-300 ease-in-out
                  ${aiLoading ? 'opacity-50 cursor-not-allowed' : ''}`}
              >
                {aiLoading ? 'Analyzing...' : 'Get Results'}
              </button>
            </div>
          </div>
        )}

        {stage === 'results' && analysisResult && (
          <div className="w-full transition-opacity duration-500 ease-in-out" ref={contentRef}>
            <h2 className="text-3xl font-bold text-center text-blue-700 mb-6">
              Your Test Results for: <br /> "{selectedTopic}"
            </h2>

            <div className="bg-blue-50 p-6 rounded-lg shadow-md border border-blue-200 mb-8 animate-fade-in-up">
              <h3 className="text-xl font-semibold text-blue-800 mb-4">Your Answers:</h3>
              <ul className="list-disc list-inside space-y-2 text-gray-700">
                {questions.map((q, qIndex) => (
                  <li key={qIndex}>
                    <span className="font-medium">{q.question}</span>: {userAnswers[qIndex]}
                  </li>
                ))}
              </ul>
            </div>

            {stabilityLevels && (
              <div className="bg-yellow-50 p-6 rounded-lg shadow-md border border-yellow-200 mb-8 animate-fade-in-up delay-100">
                <h3 className="text-xl font-semibold text-yellow-800 mb-4">Stability Check:</h3>
                <div className="grid grid-cols-1 md:grid-cols-3 gap-4 text-center">
                  {Object.entries(stabilityLevels).map(([key, value]) => (
                    <div key={key} className="p-3 bg-yellow-100 rounded-lg">
                      <p className="text-4xl mb-2">{value.emoji}</p>
                      <p className="font-semibold text-gray-800">{key.charAt(0).toUpperCase() + key.slice(1)}</p>
                      <p className="text-sm text-gray-600">{value.level}</p>
                    </div>
                  ))}
                </div>
              </div>
            )}

            <div className="bg-green-50 p-6 rounded-lg shadow-md border border-green-200 mb-8 animate-fade-in-up delay-200">
              <h3 className="text-xl font-semibold text-green-800 mb-4">AI Analysis:</h3>
              <p className="text-gray-800 leading-relaxed whitespace-pre-wrap">{analysisResult.analysis}</p>
            </div>

            <div className="bg-teal-50 p-6 rounded-lg shadow-md border border-teal-200 mb-8 animate-fade-in-up delay-300">
              <h3 className="text-xl font-semibold text-teal-800 mb-4">Actionable Advice:</h3>
              <p className="text-gray-800 leading-relaxed whitespace-pre-wrap">{analysisResult.advice}</p>
            </div>

            <p className="text-sm text-gray-500 text-center mt-8 mb-4">
              <span className="font-bold">Disclaimer:</span> This AI analysis is for informational purposes only and should not be considered a substitute for professional psychological evaluation or advice. If you have concerns about your mental health, please consult a qualified healthcare professional.
            </p>

            <div className="flex flex-col sm:flex-row justify-center gap-4 mt-8">
              <button
                onClick={handleDownloadPdf}
                disabled={!pdfLibsLoaded}
                className={`px-8 py-4 bg-red-500 text-white font-bold rounded-lg shadow-lg hover:bg-red-600 transform hover:scale-105 transition duration-300 ease-in-out
                  ${!pdfLibsLoaded ? 'opacity-50 cursor-not-allowed' : ''}`}
              >
                {pdfLibsLoaded ? 'Download Results (PDF)' : 'Loading PDF...'}
              </button>
              <button
                onClick={() => {
                  setStage('welcome');
                  setSelectedTopic('');
                  setQuestions([]);
                  setUserAnswers({});
                  setAnalysisResult(null);
                  setStabilityLevels(null);
                  setNumQuestions(5); // Reset to default
                }}
                className="px-8 py-4 bg-blue-600 text-white font-bold rounded-lg shadow-lg hover:bg-blue-700 transform hover:scale-105 transition duration-300 ease-in-out"
              >
                Start New Test
              </button>
            </div>

            <div className="mt-10 pt-6 border-t border-gray-200 text-sm text-gray-600 text-center">
              <h3 className="text-lg font-semibold text-gray-700 mb-2">References:</h3>
              <p className="text-gray-500">
                Note: The AI generates content based on its extensive training data and cannot provide specific, real-time citations from external websites for the generated questions or analysis.
                For a comprehensive psychological test requiring verifiable sources, a curated list of trusted, peer-reviewed research and psychological organizations would need to be managed and linked directly by the application's developers.
              </p>
              {/* You can add static links to general reputable psychology resources here if desired */}
              {/* <ul className="mt-4 list-disc list-inside text-left mx-auto max-w-md">
                <li><a href="https://www.apa.org/" target="_blank" rel="noopener noreferrer" className="text-blue-500 hover:underline">American Psychological Association (APA)</a></li>
                <li><a href="https://www.nimh.nih.gov/" target="_blank" rel="noopener noreferrer" className="text-blue-500 hover:underline">National Institute of Mental Health (NIMH)</a></li>
              </ul> */}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

export default App;
