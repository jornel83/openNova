import { MyComposition } from "./Composition";
import { WaterdropCompositions } from "./waterdrop/WaterdropVideo";
import { ProductConceptCompositions } from "./concept-film/ConceptFilm";

export const RemotionRoot: React.FC = () => {
  return (
    <>
      <WaterdropCompositions />
      <MyComposition />
      <ProductConceptCompositions />
    </>
  );
};
