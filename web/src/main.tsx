import '@fontsource-variable/literata';
import '@fontsource-variable/literata/wght-italic.css';
import '@fontsource/shippori-mincho/latin-500.css';
import '@fontsource/shippori-mincho/latin-700.css';
import { Component, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import './theme';
import './styles.css';

/** A rendering error shows as a message with a way out, never a blank window. */
class Boundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="crash">
        <p>Something broke: {this.state.error.message}</p>
        <button className="solid" onClick={() => { location.hash = '#/library'; location.reload(); }}>Back to library</button>
      </div>
    );
  }
}

createRoot(document.getElementById('root')!).render(<Boundary><App /></Boundary>);
