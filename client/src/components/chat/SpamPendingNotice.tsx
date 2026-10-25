import {useTranslation} from 'react-i18next';
export default function SpamPendingNotice({failed,retry}:{failed:boolean;retry:()=>void}){
 const {t}=useTranslation('chat');
 return <div role='status'><p>{t(failed?'spamFilterPendingError':'spamFilterPending')}</p>{failed&&<button type='button' onClick={retry}>{t('spamFilterRetry')}</button>}</div>;
}
