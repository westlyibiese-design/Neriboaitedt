import { initializeApp } from "firebase/app";
import { getAuth } from "firebase/auth";
import { getFirestore } from "firebase/firestore";

// Public Firebase Web config for the neribo-prod project. This is not a
// secret — see https://firebase.google.com/docs/projects/api-keys.
// Access control is enforced by Firebase Auth + Firestore Security Rules,
// not by hiding this value.
const firebaseConfig = {
  apiKey: "AIzaSyBfb_2Ld64LuwSo5n_k1yke5CoIygjSODA",
  authDomain: "neribo-prod.firebaseapp.com",
  projectId: "neribo-prod",
  storageBucket: "neribo-prod.firebasestorage.app",
  messagingSenderId: "373059167976",
  appId: "1:373059167976:web:0eddfedc82a8ea48fdcb5d",
  measurementId: "G-ZJY363CJLP",
};

export const firebaseApp = initializeApp(firebaseConfig);
export const auth = getAuth(firebaseApp);
export const db = getFirestore(firebaseApp);
