import { BUSINESS_TYPES } from '@/shared/attributes';
import { ActionForm } from '../ActionForm';
import { createAccountAction } from '../actions';

export default function NewAccount() {
  return (
    <>
      <h1>Nueva cuenta de negocio</h1>
      <ActionForm action={createAccountAction} className="card stack narrow" submit="Crear cuenta">
        <label className="field"><span>Nombre del negocio</span><input name="businessName" required minLength={2} /></label>
        <label className="field"><span>Rubro</span><select name="businessType">{Object.entries(BUSINESS_TYPES).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></label>
        <label className="field"><span>Nombre del administrador</span><input name="adminName" required minLength={2} /></label>
        <label className="field"><span>Correo</span><input name="email" type="email" required placeholder="paul@admin.pe" /></label>
        <label className="field"><span>Contraseña inicial</span><input name="password" type="text" autoComplete="off" required minLength={10} /><small>Mínimo 10 caracteres con letras y números. El cliente deberá cambiarla.</small></label>
      </ActionForm>
    </>
  );
}
