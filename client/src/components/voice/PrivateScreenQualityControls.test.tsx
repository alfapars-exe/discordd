import {cleanup,fireEvent,render,screen} from "@testing-library/react";
import {afterEach,beforeEach,expect,it,vi} from "vitest";
import {createInstance} from "i18next";
import {I18nextProvider} from "react-i18next";
import en from "../../i18n/locales/en/voice.json";
import tr from "../../i18n/locales/tr/voice.json";
import {useVoiceStore} from "../../stores/voiceStore";
import PrivateScreenQualityControls from "./PrivateScreenQualityControls";
const platform=vi.hoisted(()=>({desktop:false}));
vi.mock("../../utils/constants",()=>({isElectron:()=>platform.desktop}));
beforeEach(()=>{platform.desktop=false;useVoiceStore.setState({screenShareQuality:"720p",screenShareFps:30});});
afterEach(cleanup);
async function mount(language:"en"|"tr",audio?:{enabled:boolean;disabled?:boolean;onChange:(value:boolean)=>void}){const i18n=createInstance();await i18n.init({lng:language,resources:{en:{voice:en},tr:{voice:tr}},defaultNS:"voice",interpolation:{escapeValue:false}});return render(<I18nextProvider i18n={i18n}><PrivateScreenQualityControls audio={audio}/></I18nextProvider>);}
it.each(["en","tr"] as const)("does not infer unsupported audio from absent inline controls (%s)",async language=>{await mount(language);expect(screen.getAllByRole("combobox")).toHaveLength(2);expect(screen.queryByRole("checkbox")).toBeNull();expect(screen.queryByText(en.privateScreenVideoOnly)).toBeNull();expect(screen.queryByText(tr.privateScreenVideoOnly)).toBeNull();});
it.each([false,true])("keeps explicit %s desktop consent actionable and disabled state meaningful",async desktop=>{platform.desktop=desktop;const onChange=vi.fn();const mounted=await mount("en",{enabled:false,onChange});const label=desktop?en.privateScreenAudioWindowsConsent:en.privateScreenAudioBrowserConsent;fireEvent.click(screen.getByRole("checkbox",{name:label}));expect(onChange).toHaveBeenCalledExactlyOnceWith(true);mounted.unmount();await mount("en",{enabled:true,disabled:true,onChange});expect(screen.getByRole("checkbox",{name:label})).toBeChecked();expect(screen.getByRole("checkbox",{name:label})).toBeDisabled();expect(onChange).toHaveBeenCalledTimes(1);});
