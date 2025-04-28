
import { lazy, Suspense } from 'react';
import { createBrowserRouter, RouterProvider } from 'react-router-dom';
import { AppLayout } from '@/components/layout/AppLayout';
import LoadingPage from '@/components/ui/LoadingPage';

// Code-split route components
const HomePage = lazy(() => import('@/pages/HomePage'));
const SearchPage = lazy(() => import('@/pages/SearchPage'));
const ProducerPage = lazy(() => import('@/pages/ProducerPage'));
const ArtistPage = lazy(() => import('@/pages/ArtistPage'));
const NotFound = lazy(() => import('@/pages/NotFound'));

// Router configuration
const router = createBrowserRouter([
  {
    path: '/',
    element: <AppLayout />,
    children: [
      {
        index: true,
        element: (
          <Suspense fallback={<LoadingPage />}>
            <HomePage />
          </Suspense>
        ),
      },
      {
        path: 'search',
        element: (
          <Suspense fallback={<LoadingPage />}>
            <SearchPage />
          </Suspense>
        ),
      },
      {
        path: 'producer/:id',
        element: (
          <Suspense fallback={<LoadingPage />}>
            <ProducerPage />
          </Suspense>
        ),
      },
      {
        path: 'artist/:id',
        element: (
          <Suspense fallback={<LoadingPage />}>
            <ArtistPage />
          </Suspense>
        ),
      },
      {
        path: '*',
        element: (
          <Suspense fallback={<LoadingPage />}>
            <NotFound />
          </Suspense>
        ),
      },
    ],
  },
]);

export function Routes() {
  return <RouterProvider router={router} />;
}
