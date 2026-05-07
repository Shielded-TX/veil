import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { VeilProvider } from './context/VeilContext';
import { Shell } from './components/Shell/Shell';

import { Connect }   from './pages/Connect';
import { Dashboard } from './pages/Dashboard';
import { Register }  from './pages/Register';
import { Send }      from './pages/Send';
import { Withdraw }  from './pages/Withdraw';
import { Inspect }   from './pages/Inspect';
import { Auditor }   from './pages/Auditor';
import { Deposit }   from './pages/Deposit';

export function App() {
    return (
        <BrowserRouter>
            <VeilProvider>
                <Routes>
                    {/* Entry — no shell */}
                    <Route path="/connect" element={<Connect />} />

                    {/* Authenticated shell */}
                    <Route element={<Shell />}>
                        <Route path="/"         element={<Dashboard />} />
                        <Route path="/register" element={<Register />}  />
                        <Route path="/send"     element={<Send />}      />
                        <Route path="/withdraw" element={<Withdraw />}  />
                        <Route path="/inspect"  element={<Inspect />}   />
                        <Route path="/inspect/:txHash" element={<Inspect />} />
                        <Route path="/auditor"  element={<Auditor />}   />
                        <Route path="/deposit"  element={<Deposit />}   />
                    </Route>

                    {/* Fallback */}
                    <Route path="*" element={<Navigate to="/" replace />} />
                </Routes>
            </VeilProvider>
        </BrowserRouter>
    );
}
