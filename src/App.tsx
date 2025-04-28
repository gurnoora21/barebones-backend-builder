
import { BrowserRouter, Routes, Route } from "react-router-dom";
import { Toaster } from 'sonner';
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
// We'll install the devtools but make it conditional based on environment
import { Routes as AppRoutes } from './routes';
import "./App.css";

// Create a client
const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      refetchOnWindowFocus: false,
      staleTime: 1000 * 60 * 5, // 5 minutes
      retry: 1,
    },
  },
});

export default function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <Toaster position="top-center" />
      <AppRoutes />
      {process.env.NODE_ENV !== 'production' && (
        <div className="hidden">
          {/* ReactQueryDevtools will be dynamically imported only in development */}
        </div>
      )}
    </QueryClientProvider>
  );
}
