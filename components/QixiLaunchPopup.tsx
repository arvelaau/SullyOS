import React, { useEffect } from 'react';
import { useOS } from '../context/OSContext';
import { AppID } from '../types';
import { trackEvent } from '../utils/analytics';
import { markQixiLaunchPopupSeen } from '../utils/qixiLaunchPopup';
import './QixiLaunchPopup.css';

interface QixiLaunchPopupProps {
    onClose: () => void;
}

export const QixiLaunchPopup: React.FC<QixiLaunchPopupProps> = ({ onClose }) => {
    const { openApp } = useOS();

    useEffect(() => {
        trackEvent('Show Qixi Special Event Reminder', { Date: '2026-08-19', Timezone: 'Asia/Shanghai' });
    }, []);

    const dismiss = () => {
        markQixiLaunchPopupSeen();
        onClose();
        trackEvent('Dismiss Qixi Special Event Reminder', { Destination: 'Close' });
    };

    const openQixi = () => {
        markQixiLaunchPopupSeen();
        onClose();
        openApp(AppID.SpecialMoments);
        trackEvent('Tap Qixi Special Event Reminder', { Destination: 'Special Moments' });
    };

    return (
        <div className="qixi-launch-overlay" onMouseDown={event => {
            if (event.target === event.currentTarget) dismiss();
        }}>
            <section
                className="qixi-launch-letter"
                role="dialog"
                aria-modal="true"
                aria-labelledby="qixi-launch-title"
                aria-describedby="qixi-launch-description"
            >
                <button type="button" className="qixi-launch-close" aria-label="Close Qixi event reminder" onClick={dismiss}>×</button>

                <div className="qixi-launch-date"><span>BEIJING</span><b>2026 · 08 · 19</b></div>

                <div className="qixi-launch-sky" aria-hidden="true">
                    <i className="qixi-launch-star is-user" />
                    <i className="qixi-launch-star is-char" />
                    <span className="qixi-launch-thread is-user" />
                    <span className="qixi-launch-thread is-char" />
                    <b className="qixi-launch-knot" />
                </div>

                <div className="qixi-launch-copy">
                    <p>QIXI EVE · ONE-TIME ALERT</p>
                    <h2 id="qixi-launch-title"><small>A message</small>fell into the starry night.</h2>
                    <div id="qixi-launch-description">
                        <strong>They're looking for you too, on the other side.</strong>
                        <span>Tonight, go to 「Special Moments」and choose someone you want to see.</span>
                    </div>
                </div>

                <footer>
                    <button type="button" className="qixi-launch-primary" onClick={openQixi}>
                        <span>Go meet them</span><i aria-hidden="true">✦</i>
                    </button>
                    <button type="button" className="qixi-launch-later" onClick={dismiss}>Save this letter for later</button>
                </footer>

                <p className="qixi-launch-note">Still available from 「Special Moments」on the desktop after the event</p>
            </section>
        </div>
    );
};

export default QixiLaunchPopup;
